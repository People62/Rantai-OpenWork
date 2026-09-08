// Stage 3 spike. Tauri gives the interface the desktop bridge it expects.
//
// The interface reaches the desktop through one function:
//   window.__OPENWORK_ELECTRON__.invokeDesktop(command, ...args)
// which fans out to 82 commands. Only a handful of those are genuinely native.
// The rest live in plain Node modules that never import electron, so a Node
// sidecar (bridge-host.mjs) serves them from the original source and this file
// keeps only the window, the init script, and the file dialogs.
//
// Electron remains the shipping shell. Nothing here is wired into a release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

/// What bridge-host.mjs prints once it is listening.
#[derive(Debug, Deserialize)]
struct BridgeReady {
    port: u16,
    token: String,
    #[serde(rename = "appUrl")]
    app_url: String,
}

fn repo_root() -> PathBuf {
    let resolved = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("cannot resolve the repository root");

    // canonicalize returns an extended-length path on Windows (\\?\C:\...),
    // and that prefix is handed straight to bun as a script argument. Strip it
    // back to an ordinary drive path.
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy().to_string();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC\\") {
                return PathBuf::from(stripped);
            }
        }
    }

    resolved
}

/// Starts the bridge host and blocks until it reports its port, so the window
/// is never built before the init script has an address to talk to.
fn start_bridge(root: &PathBuf) -> (Child, BridgeReady) {
    let mut child = Command::new("bun")
        .arg(root.join("apps/desktop-tauri/bridge-host.mjs"))
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn the bridge host; is bun on PATH?");

    let stdout = child.stdout.take().expect("bridge host has no stdout");
    let mut lines = BufReader::new(stdout).lines();

    while let Some(Ok(line)) = lines.next() {
        if let Some(json) = line.strip_prefix("[bridge] ready ") {
            let ready: BridgeReady = serde_json::from_str(json).expect("malformed bridge ready line");
            // Keep draining stdout, or the pipe fills and the host blocks.
            std::thread::spawn(move || while let Some(Ok(line)) = lines.next() {
                println!("{line}");
            });
            return (child, ready);
        }
        println!("{line}");
    }

    let _ = child.kill();
    panic!("the bridge host exited before reporting a port");
}

/// The native half of the bridge. Everything else is forwarded to the host.
#[tauri::command]
async fn desktop_native(
    app: tauri::AppHandle,
    command: String,
    args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    match command.as_str() {
        "pickDirectory" => {
            let multiple = args
                .first()
                .and_then(|value| value.get("multiple"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);

            // blocking_pick_folder would deadlock the async command; the
            // channel keeps the dialog on its own thread.
            let (tx, rx) = std::sync::mpsc::channel();
            eprintln!("[spike] opening the folder dialog");
            app.dialog().file().pick_folder(move |folder| {
                let _ = tx.send(folder);
            });
            let picked = rx.recv().map_err(|error| error.to_string())?;
            eprintln!("[spike] folder dialog returned");

            Ok(match picked {
                None => serde_json::Value::Null,
                Some(folder) => {
                    let path = folder.to_string();
                    if multiple {
                        serde_json::json!([path])
                    } else {
                        serde_json::Value::String(path)
                    }
                }
            })
        }
        // Answers the init script's startup probe. Loading the page from
        // openwork-server means IPC arrives from a remote origin, which Tauri
        // refuses unless the capability grants it; the probe proves the grant
        // took effect instead of leaving it to be discovered on first use.
        "__ipcProbe" => Ok(serde_json::json!({ "ok": true, "from": "rust" })),
        // Deliberately inert for now: the gate is workspace creation, and
        // reporting the gap beats a silent no-op.
        other => Err(format!("Tauri native bridge: {other} is not implemented yet")),
    }
}

/// The preload equivalent. Electron's preload.mjs runs before the page; Tauri's
/// initialization_script does the same, so the interface finds the bridge on
/// its first read and needs no change at all.
fn init_script(ready: &BridgeReady, meta: &str) -> String {
    format!(
        r#"(function () {{
  var BRIDGE = "http://127.0.0.1:{port}";
  var TOKEN = "{token}";
  var NATIVE = ["pickDirectory", "pickFile", "saveFile", "__openPath", "__revealItemInDir",
                "__setZoomFactor", "__setNativeTheme", "__setApplicationMenuVisible",
                "setWindowDecorations", "desktopNotificationShow"];

  function native(command, args) {{
    return window.__TAURI_INTERNALS__.invoke("desktop_native", {{ command: command, args: args }});
  }}

  function host(command, args) {{
    return fetch(BRIDGE + "/invoke", {{
      method: "POST",
      headers: {{ "content-type": "application/json", authorization: "Bearer " + TOKEN }},
      body: JSON.stringify({{ command: command, args: args }}),
    }}).then(function (response) {{
      return response.json().then(function (body) {{
        if (!response.ok) throw new Error(body.error || response.statusText);
        return body.value;
      }});
    }});
  }}

  function invokeDesktop(command) {{
    var args = Array.prototype.slice.call(arguments, 1);
    return NATIVE.indexOf(command) >= 0 ? native(command, args) : host(command, args);
  }}

  // Electron's preload marks the document so the chrome-inset CSS applies.
  function markShell() {{
    var root = document && document.documentElement;
    if (!root) return false;
    root.dataset.openworkShell = "electron";
    root.classList.add("openwork-electron", "openwork-platform-linux");
    return true;
  }}
  if (!markShell()) document.addEventListener("DOMContentLoaded", markShell, {{ once: true }});

  // Report whether remote-origin IPC actually works, so the log says so rather
  // than the first native call failing in the middle of a user action.
  if ({probe_dialog}) {{
    native("pickDirectory", [{{}}]).then(function (picked) {{
      return host("__dialogProbeResult", [{{ ok: true, picked: picked }}]);
    }}).catch(function (error) {{
      return host("__dialogProbeResult", [{{ ok: false, error: String(error) }}]);
    }});
  }}

  native("__ipcProbe", []).then(function (result) {{
    return host("__ipcProbeResult", [{{ ok: true, result: result }}]);
  }}).catch(function (error) {{
    return host("__ipcProbeResult", [{{ ok: false, error: String(error) }}]);
  }});

  var noop = function () {{ return Promise.resolve(null); }};
  var noopSubscribe = function () {{ return function () {{}}; }};

  window.__OPENWORK_ELECTRON__ = {{
    invokeDesktop: invokeDesktop,
    automationRunner: {{ onCredentialRejected: noopSubscribe }},
    shell: {{
      openExternal: function (url) {{ return native("__openExternal", [url]); }},
      relaunch: noop,
    }},
    system: {{
      getArchitectureInfo: function () {{ return host("__architecture", []); }},
      getMicrophoneStatus: function () {{ return Promise.resolve({{ platform: "linux", status: "not-mac" }}); }},
      askMicrophoneAccess: function () {{ return Promise.resolve({{ platform: "linux", granted: true, status: "not-mac" }}); }},
    }},
    migration: {{ readSnapshot: noop, ackSnapshot: noop }},
    brandIcon: {{ apply: noop, getState: noop }},
    dev: {{ evalRelaunch: noop }},
    nuke: {{ preview: noop, execute: noop }},
    updater: {{
      getChannel: noop, setChannel: noop, check: noop, download: noop,
      installAndRestart: noop, onDownloadProgress: noopSubscribe,
    }},
    recovery: {{ recordHealthy: noop, list: noop, restorePrevious: noop, use: noop }},
    meta: {meta},
  }};
}})();"#,
        port = ready.port,
        token = ready.token,
        meta = meta,
        probe_dialog = std::env::var("RANTAI_SPIKE_PROBE_DIALOG").as_deref() == Ok("1"),
    )
}

fn main() {
    let root = repo_root();
    let (bridge, ready) = start_bridge(&root);
    let mut bridge = Some(bridge);
    println!("[spike] bridge on 127.0.0.1:{}, app at {}", ready.port, ready.app_url);

    // preload.mjs reads the bootstrap synchronously before the page runs. Tauri
    // has no sync IPC, so the values are baked into the script instead.
    let meta = fetch_meta(&ready).unwrap_or_else(|error| {
        if let Some(child) = bridge.as_mut() { let _ = child.kill(); }
        panic!("could not read bridge meta: {error}");
    });

    // Under smoke the bridge decides the verdict, so the window process has to
    // carry its exit status out to CI rather than sitting on the event loop.
    if std::env::var("RANTAI_SPIKE_SMOKE").as_deref() == Ok("1") {
        let mut child = bridge.take().expect("bridge child already taken");
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(1);
            std::process::exit(code);
        });
    }

    let script = init_script(&ready, &meta);
    let url = ready.app_url.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_native])
        .setup(move |app| {
            use tauri::WebviewUrl;
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("invalid app url")),
            )
            .title("Rantai (Tauri spike)")
            .inner_size(1280.0, 860.0)
            .initialization_script(&script)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the Rantai Tauri spike");

    if let Some(mut child) = bridge { let _ = child.kill(); }
}

/// One loopback GET, written by hand rather than pulled from a crate: the spike
/// needs exactly one request, and shelling out to curl would tie the build to a
/// binary that is not the same on all three platforms.
fn get_json(ready: &BridgeReady, path: &str) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};

    let mut stream = TcpStream::connect(("127.0.0.1", ready.port)).map_err(|e| e.to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        ready.token,
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;

    // Connection: close means no chunked encoding to unpick; the body is
    // whatever follows the blank line.
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no header terminator in the bridge response")?;
    serde_json::from_slice(&raw[split + 4..]).map_err(|e| e.to_string())
}

/// Reads the bootstrap and distribution the preload would have fetched
/// synchronously, and shapes them into the meta object the interface reads.
fn fetch_meta(ready: &BridgeReady) -> Result<String, String> {
    let body = get_json(ready, "/meta")?;

    Ok(serde_json::json!({
        "desktopBootstrap": body.get("desktopBootstrap").cloned().unwrap_or(serde_json::Value::Null),
        "distribution": body.get("distribution").cloned().unwrap_or(serde_json::Value::Null),
        "initialDeepLinks": [],
        "platform": "linux",
        "version": "tauri-spike",
        "evalFatalBootstrapFailure": serde_json::Value::Null,
    })
    .to_string())
}
