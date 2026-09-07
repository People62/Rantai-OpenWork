// Stage 2 spike. Tauri spawns openwork-server as a sidecar and loads the UI
// from it, instead of from a static dist.
//
// The point of serving through the server is that it injects
// __OPENWORK_BOOTSTRAP__ into index.html with the session token, so the
// interface finds its backend without any IPC bridge. That is what makes this
// stage cheap: no Rust equivalent of the 17 preload functions is needed yet.
//
// Electron remains the shipping shell. Nothing here is wired into a release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8799; // deliberately not 8778, so a running dev stack is untouched

/// Repository root, walked up from the compiled crate.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("cannot resolve the repository root")
}

/// Mirrors scripts/dev-headless-web-lib.ts: bun runs the server from source.
///
/// The dist must be built with VITE_OPENWORK_DEPLOYMENT=web. A desktop build
/// waits for the Electron bridge, never falls back to the same origin, and so
/// resolves an empty backend URL — the window renders but makes no API call.
fn spawn_server(root: &PathBuf) -> Child {
    let dist = root.join("apps/app/dist");
    let config = root.join("tmp/tauri-spike-server.json");

    Command::new("bun")
        .arg("--conditions=development")
        .arg(root.join("apps/server/src/cli.ts"))
        .arg("--port")
        .arg(PORT.to_string())
        .arg("--host")
        .arg(HOST)
        .arg("--config")
        .arg(&config)
        // A workspace, so the interface has something to load; without one it
        // stops at onboarding and never exercises the API.
        .arg("--workspace")
        .arg(root)
        .env("OPENWORK_WEB_ROOT", &dist)
        // Mirrors scripts/dev-headless-web.ts: without these the server never
        // starts the OpenCode engine and every /opencode/* route answers
        // opencode_unconfigured.
        .env("OPENWORK_MANAGE_OPENCODE", "1")
        .env("OPENWORK_OPENCODE_BIN", "opencode")
        // No OPENWORK_DEV_MODE here: it enables the reload watcher, which
        // restarts the server on a random port and strands the window.
        .current_dir(root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn openwork-server; is bun on PATH?")
}

/// The window must not open before the port answers, or the webview lands on a
/// connection error and never retries.
fn wait_for_port(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((HOST, PORT)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn main() {
    let root = repo_root();
    let mut server = spawn_server(&root);

    if !wait_for_port(Duration::from_secs(60)) {
        let _ = server.kill();
        panic!("openwork-server did not answer on {HOST}:{PORT} within 60s");
    }
    println!("[spike] server up on http://{HOST}:{PORT}");

    let url = format!("http://{HOST}:{PORT}/");
    tauri::Builder::default()
        .setup(move |app| {
            use tauri::WebviewUrl;
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("invalid server url")),
            )
            .title("Rantai (Tauri spike)")
            .inner_size(1280.0, 860.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start the Rantai Tauri spike");

    // The sidecar is ours; it must not outlive the window.
    let _ = server.kill();
}
