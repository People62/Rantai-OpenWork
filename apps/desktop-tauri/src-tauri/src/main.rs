// Stage 1 spike. One window, nothing else.
//
// The only question this answers: does apps/app render correctly in the
// system webview — WebKitGTK here, WKWebView on macOS, WebView2 on Windows.
// No IPC, no sidecars, no features. Electron remains the shipping shell.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start the Rantai Tauri spike");
}
