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

/// The scheme Electron registers as DESKTOP_PROTOCOL_SCHEME, declared for the
/// plugin in tauri.conf.json and repeated here for the runtime calls.
const DEEP_LINK_SCHEME: &str = "openwork";

/// The shape desktop-integration-section.tsx reads.
///
/// Electron can say more: it reads back the entry it wrote and reports which
/// fields drifted, so the interface can offer a repair. The plugin exposes no
/// equivalent, so this reports whether the scheme is currently ours and leaves
/// the issues list empty rather than inventing findings.
fn desktop_integration_status(app: &tauri::AppHandle) -> serde_json::Value {
    use tauri_plugin_deep_link::DeepLinkExt;

    if !cfg!(any(target_os = "linux", windows)) {
        return serde_json::json!({
            "supported": false,
            "state": "unsupported",
            "ownership": "none",
            "appImagePath": null,
            "desktopEntryPath": null,
            "handlerDesktopId": null,
            "issues": [],
        });
    }

    let registered = app.deep_link().is_registered(DEEP_LINK_SCHEME).unwrap_or(false);
    serde_json::json!({
        "supported": true,
        "state": if registered { "integrated" } else { "not_integrated" },
        "ownership": if registered { "openwork" } else { "none" },
        "appImagePath": std::env::var("APPIMAGE").ok(),
        "desktopEntryPath": null,
        "handlerDesktopId": null,
        "issues": [],
    })
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

        // Electron ports 590 lines to write a .desktop entry and register the
        // MIME handler. The deep-link plugin already does the same work — and on
        // Windows writes the registry keys setAsDefaultProtocolClient would — so
        // this is a call, not a port. What is lost is the repair diagnostics:
        // Electron inspects the entry it wrote and reports which parts drifted.
        "desktopIntegrationStatus" => Ok(desktop_integration_status(&app)),
        "desktopIntegrationInstall" => {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.deep_link()
                .register(DEEP_LINK_SCHEME)
                .map_err(|error| error.to_string())?;
            Ok(desktop_integration_status(&app))
        }
        "desktopIntegrationRemove" => {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.deep_link()
                .unregister(DEEP_LINK_SCHEME)
                .map_err(|error| error.to_string())?;
            Ok(desktop_integration_status(&app))
        }
        // Deliberately inert for now: the gate is workspace creation, and
        // reporting the gap beats a silent no-op.
        other => Err(format!("Tauri native bridge: {other} is not implemented yet")),
    }
}

/// The native application menu.
///
/// Mirrors apps/desktop/electron/app-menu.mjs: same items, same shortcuts, and
/// the same four events dispatched into the page — the interface already listens
/// for them, so nothing on the React side changes.
///
/// Tauri supplies the standard items (undo, copy, quit …) as predefined roles.
/// What it has no equivalent for is macOS's paste-and-match-style, delete and
/// Speech submenu; those are left out rather than hand-rolled.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
        .accelerator(if cfg!(target_os = "macos") { "CmdOrCtrl+," } else { "Ctrl+," })
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+Plus")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let docs = MenuItemBuilder::with_id("docs", "Docs").build(app)?;

    let mut menu = MenuBuilder::new(app);

    // On macOS the first submenu is the application menu, and Settings and
    // Check for Updates belong there rather than in File and Help.
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Rantai")
            .about(None)
            .separator()
            .item(&check_updates)
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    let mut file = SubmenuBuilder::new(app, "File");
    if !cfg!(target_os = "macos") {
        file = file.item(&settings).separator();
    }
    let file = file.close_window().build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .item(&zoom_reset)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .fullscreen()
        .build()?;

    let mut window = SubmenuBuilder::new(app, "Window").minimize().maximize();
    if cfg!(target_os = "macos") {
        window = window.separator().bring_all_to_front();
    }
    let window = window.separator().close_window().build()?;

    let mut help = SubmenuBuilder::new(app, "Help");
    if !cfg!(target_os = "macos") {
        help = help.item(&check_updates);
    }
    let help = help.item(&docs).build()?;

    menu.item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
}

/// The script a menu id dispatches into the page.
///
/// Split out from the click handler because this is the half that can be
/// silently wrong: an event name that no longer matches what the interface
/// listens for produces a menu item that does nothing, with no error anywhere.
/// A GTK menu cannot be clicked from a headless machine, so this is the part
/// worth testing instead.
fn menu_event_script(id: &str) -> Option<String> {
    let dispatch = |name: &str| Some(format!(r#"window.dispatchEvent(new Event("{name}"))"#));

    match id {
        "open-settings" => dispatch("openwork:native-menu:open-settings"),
        "toggle-sidebar" => dispatch("openwork:native-menu:toggle-sidebar"),
        "check-updates" => dispatch("openwork:native-menu:check-updates"),
        "zoom-reset" | "zoom-in" | "zoom-out" => {
            // The interface reads this from event.detail, and Electron sends
            // "reset" | "in" | "out".
            let action = id.trim_start_matches("zoom-");
            Some(format!(
                r#"window.dispatchEvent(new CustomEvent("openwork:native-menu:zoom", {{ detail: "{action}" }}))"#,
            ))
        }
        // No opener plugin in the spike yet; the interface routes external links
        // itself, so hand it the URL the same way a link would.
        "docs" => Some(r#"window.open("https://openworklabs.com/docs", "_blank")"#.to_string()),
        _ => None,
    }
}

/// Menu clicks reach the interface as the events Electron's preload dispatched.
/// Keeping the names identical is what makes the React side portable.
fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    use tauri::Manager;

    let Some(js) = menu_event_script(id) else { return };

    if let Some(webview) = app.get_webview_window("main") {
        if let Err(error) = webview.eval(&js) {
            eprintln!("[spike] menu {id}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::menu_event_script;

    /// The names the interface listens for, copied from preload.mjs. If these
    /// drift, every menu item goes quiet without failing.
    #[test]
    fn dispatches_the_events_the_interface_listens_for() {
        for (id, expected) in [
            ("open-settings", "openwork:native-menu:open-settings"),
            ("toggle-sidebar", "openwork:native-menu:toggle-sidebar"),
            ("check-updates", "openwork:native-menu:check-updates"),
        ] {
            let script = menu_event_script(id).expect(id);
            assert!(script.contains(expected), "{id} dispatched {script}");
        }
    }

    #[test]
    fn zoom_carries_the_action_electron_sends() {
        for (id, action) in [("zoom-reset", "reset"), ("zoom-in", "in"), ("zoom-out", "out")] {
            let script = menu_event_script(id).expect(id);
            assert!(script.contains("openwork:native-menu:zoom"), "{id}: {script}");
            assert!(script.contains(&format!(r#"detail: "{action}""#)), "{id}: {script}");
        }
    }

    #[test]
    fn unknown_ids_do_nothing() {
        assert!(menu_event_script("no-such-item").is_none());
    }
}

/// Hands received deep links to the page as Electron's preload did.
///
/// The interface listens for "openwork:deep-link-native" with the URLs in
/// event.detail, then calls connectLinkVerify and connectLinkAccept over the
/// bridge — and those two are served by the original connect-link.mjs, so none
/// of its 497 lines of signature checking is reimplemented here.
fn deliver_deep_links(app: &tauri::AppHandle, urls: &[String]) {
    use tauri::Manager;

    if urls.is_empty() {
        return;
    }
    let Ok(detail) = serde_json::to_string(urls) else { return };
    let js = format!(
        r#"window.dispatchEvent(new CustomEvent("openwork:deep-link-native", {{ detail: {detail} }}))"#,
    );

    if let Some(webview) = app.get_webview_window("main") {
        if let Err(error) = webview.eval(&js) {
            eprintln!("[spike] deep link: {error}");
        }
    } else {
        eprintln!("[spike] deep link arrived before the window: {urls:?}");
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
                "setWindowDecorations", "desktopNotificationShow",
                "desktopIntegrationStatus", "desktopIntegrationInstall", "desktopIntegrationRemove"];

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

  // Desktop integration cannot be reached over the bridge — it is a Rust
  // command — so an opt-in probe drives the round trip instead: read, install,
  // read, remove, read.
  if ({probe_integration}) {{
    (function () {{
      var read = function () {{ return native("desktopIntegrationStatus", []); }};
      read().then(function (before) {{
        return native("desktopIntegrationInstall", []).then(read).then(function (after) {{
          return native("desktopIntegrationRemove", []).then(read).then(function (final) {{
            return host("__integrationProbeResult", [{{
              before: before.state, afterInstall: after.state, afterRemove: final.state,
            }}]);
          }});
        }});
      }}).catch(function (error) {{
        return host("__integrationProbeResult", [{{ error: String(error) }}]);
      }});
    }})();
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
        probe_integration = std::env::var("RANTAI_SPIKE_PROBE_INTEGRATION").as_deref() == Ok("1"),
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
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![desktop_native])
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .setup(move |app| {
            use tauri::WebviewUrl;

            app.set_menu(build_menu(app.handle())?)?;

            // Electron registers openwork:// with app.setAsDefaultProtocolClient
            // and receives URLs through open-url on macOS and second-instance
            // everywhere else. The plugin covers both shapes; what it hands back
            // still has to reach the page under the name preload.mjs used.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    deliver_deep_links(&handle, &urls);
                });
            }
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
