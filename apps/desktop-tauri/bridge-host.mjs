// Stage 3 spike: the desktop bridge, as a Node sidecar.
//
// The interface reaches the desktop through one function —
// window.__OPENWORK_ELECTRON__.invokeDesktop(command, ...args) — which fans out
// to 82 commands. Rewriting those in Rust would mean porting workspace-store
// (1231 lines), runtime (2304) and nuke (860). None of them import electron, so
// this host imports the real modules instead and serves the same commands over
// loopback HTTP. Rust keeps only what is genuinely native: the window, the init
// script, and the file dialogs.
//
// Nothing here is wired into a release. Electron remains the shipping shell.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createWorkspaceStore } from "../desktop/electron/workspace-store.mjs";
import { resolveDesktopDistribution } from "../desktop/electron/desktop-distribution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 8799;

// Smoke mode: run unattended, decide whether the webview actually brought the
// interface up, and exit with a status CI can read. The gate this answers is
// stage 1's — does apps/app render in this platform's webview — which only
// WebKitGTK had ever been checked against.
const SMOKE = process.env.RANTAI_SPIKE_SMOKE === "1";
const SMOKE_TIMEOUT_MS = Number(process.env.RANTAI_SPIKE_SMOKE_TIMEOUT_MS ?? 120000);
const SERVER_TOKEN = randomUUID();
const SERVER_HOST_TOKEN = randomUUID();
const BRIDGE_TOKEN = randomUUID();

// A separate profile, so the spike never touches the Electron install's state.
const USER_DATA = path.join(os.homedir(), ".openwork-tauri-spike");
mkdirSync(USER_DATA, { recursive: true });

// workspace-store asks the injected app object for exactly one thing.
const fakeApp = {
  getPath(name) {
    if (name === "userData") return USER_DATA;
    return path.join(USER_DATA, name);
  },
  getVersion: () => "0.0.0-tauri-spike",
};

const workspaceStore = createWorkspaceStore({
  app: fakeApp,
  defaultDenBaseUrl: "https://app.openworklabs.com",
  defaultRequireSignin: false,
  forceRequireSignin: false,
});

const distribution = resolveDesktopDistribution({
  isPackaged: false,
  packageFlavor: undefined,
  environmentFlavor: process.env.OPENWORK_DESKTOP_DISTRIBUTION,
});

// --- the managed openwork-server -------------------------------------------

let serverChild = null;

/// runtime.mjs hands openwork-server the workspace paths it should serve. The
/// store is the source of truth for those, so the config is rewritten from it
/// on every start; otherwise a workspace created in the interface stays
/// invisible to the server until the next launch.
async function writeServerConfig(configPath) {
  const paths = await workspaceStore.listLocalWorkspacePaths();
  writeFileSync(configPath, JSON.stringify({
    authorizedRoots: paths,
    workspaces: paths.map((entry) => ({ path: entry })),
  }, null, 2));
  return paths;
}

function startOpenworkServer() {
  const dist = path.join(ROOT, "apps/app/dist");
  const config = path.join(USER_DATA, "server.json");

  serverChild = spawn(
    "bun",
    [
      "--conditions=development",
      path.join(ROOT, "apps/server/src/cli.ts"),
      "--port", String(SERVER_PORT),
      "--host", SERVER_HOST,
      "--config", config,
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        OPENWORK_WEB_ROOT: dist,
        OPENWORK_TOKEN: SERVER_TOKEN,
        OPENWORK_HOST_TOKEN: SERVER_HOST_TOKEN,
        // Without these the server never starts the OpenCode engine and every
        // /opencode/* route answers opencode_unconfigured. Skipped under smoke:
        // the question there is whether the webview renders, and CI runners
        // have no opencode binary to manage.
        ...(SMOKE ? {} : {
          OPENWORK_MANAGE_OPENCODE: "1",
          OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN ?? "opencode",
        }),
      },
    },
  );

  serverChild.on("exit", (code) => {
    console.error(`[bridge] openwork-server exited with ${code}`);
    serverChild = null;
  });
}

function openworkServerInfo() {
  const baseUrl = `http://${SERVER_HOST}:${SERVER_PORT}`;
  return {
    running: Boolean(serverChild && serverChild.exitCode === null && !serverChild.killed),
    engineRollover: false,
    remoteAccessEnabled: false,
    host: SERVER_HOST,
    port: SERVER_PORT,
    baseUrl,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: SERVER_TOKEN,
    ownerToken: SERVER_TOKEN,
    hostToken: SERVER_HOST_TOKEN,
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    pid: serverChild?.pid ?? null,
    lastStdout: "",
    lastStderr: "",
    managedOpencodeExecution: null,
  };
}

// --- commands ---------------------------------------------------------------

// Commands the webview handles in Rust (native dialogs, shell, window chrome).
// Listed so a stray call here is reported as a routing bug, not a gap.
const NATIVE_IN_RUST = new Set([
  "pickDirectory", "pickFile", "saveFile",
  "__openPath", "__revealItemInDir", "__setZoomFactor",
  "__setNativeTheme", "__setApplicationMenuVisible", "setWindowDecorations",
  "desktopNotificationShow",
]);

const commands = {
  workspaceBootstrap: () => workspaceStore.readWorkspaceState(),
  workspaceSetSelected: (id) => workspaceStore.setSelectedWorkspace(typeof id === "string" ? id : ""),
  workspaceSetRuntimeActive: (id) =>
    workspaceStore.setRuntimeActiveWorkspace(typeof id === "string" && id.trim() ? id : null),
  workspaceCreate: (input) => workspaceStore.createWorkspace(input ?? {}),
  workspaceCreateRemote: (input) => workspaceStore.createRemoteWorkspace(input ?? {}),
  workspaceUpdateRemote: (input) => workspaceStore.updateRemoteWorkspace(input ?? {}),
  workspaceUpdateDisplayName: (input) => workspaceStore.updateWorkspaceDisplayName(input ?? {}),
  workspaceForget: (id) => workspaceStore.forgetWorkspace(String(id ?? "").trim()),
  workspaceAddAuthorizedRoot: (input) => workspaceStore.addAuthorizedRoot(input ?? {}),
  workspaceOpenworkRead: (input) =>
    workspaceStore.readWorkspaceOpenworkConfig(String(input?.workspacePath ?? "").trim()),
  workspaceOpenworkWrite: (input) => workspaceStore.writeWorkspaceOpenworkConfig(input ?? {}),

  getDesktopBootstrapConfig: () => workspaceStore.getDesktopBootstrapConfig(),
  setDesktopBootstrapConfig: (input) => workspaceStore.setDesktopBootstrapConfig(input ?? {}),
  clearDesktopBootstrapConfig: () => workspaceStore.clearDesktopBootstrapConfig(),
  debugDesktopBootstrapConfig: () => workspaceStore.debugDesktopBootstrapConfig(),

  openworkServerInfo: () => openworkServerInfo(),
  runtimeBootstrap: () => ({ ok: true, openworkServer: openworkServerInfo() }),
  runtimeStatus: () => ({ ok: true, openworkServer: openworkServerInfo() }),

  engineInfo: () => ({
    running: Boolean(serverChild),
    runtime: "managed",
    managedByServer: true,
    baseUrl: null,
    projectDir: null,
    hostname: SERVER_HOST,
    port: null,
    opencodeUsername: null,
    opencodePassword: null,
    opencodeBinPath: null,
    opencodeBinSource: null,
    lifecycleState: serverChild ? "running" : "stopped",
  }),

  // The server is spawned here rather than by runtime.mjs, so a restart is a
  // restart of that child. Same effect for the interface; far less surface.
  openworkServerRestart: async () => {
    if (serverChild) {
      serverChild.kill();
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await writeServerConfig(path.join(USER_DATA, "server.json"));
    startOpenworkServer();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return openworkServerInfo();
  },

  appBuildInfo: () => ({
    version: fakeApp.getVersion(),
    gitSha: null,
    buildEpoch: null,
    openworkDevMode: false,
  }),

  // Telemetry is deliberately inert in the spike; reporting "disabled" is the
  // honest answer, and the interface treats it as a normal state.
  desktopSentrySetSession: () => ({ enabled: false }),
  desktopSentryClearSession: () => ({ enabled: false }),

  // The automation runner needs a Den credential the spike profile does not
  // have. Declining is a state the interface already handles.
  automationRunnerConfigure: () => ({ ok: false, reason: "not-configured" }),

  // The init script reports the outcome of its remote-origin IPC probe here.
  __ipcProbeResult: (result) => {
    console.error(`[bridge] IPC probe: ${JSON.stringify(result)}`);
    if (result?.ok === true) recordSignal("remote-origin IPC into Rust");
    return { received: true };
  },

  __dialogProbeResult: (result) => {
    console.error(`[bridge] dialog probe: ${JSON.stringify(result)}`);
    return { received: true };
  },

  __architecture: () => ({
    platform: process.platform,
    arch: process.arch,
    nodeArch: process.arch,
    rosetta: false,
  }),

  // Electron proxies cross-origin requests through the main process because the
  // renderer cannot set arbitrary headers. Node has no such limit.
  __fetch: async (url, init = {}) => {
    const target = String(url ?? "").trim();
    if (!target) throw new Error("URL is required.");
    const response = await fetch(target, {
      method: typeof init.method === "string" ? init.method : undefined,
      headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },
};

// Every command the interface asks for that is not served yet, so the gaps show
// up as a list instead of one failure at a time.
const missing = new Map();

// --- smoke verdict ----------------------------------------------------------

// Three signals, each of which can only happen if the one before it did. Taken
// together they say the webview loaded the page, ran the bundle, mounted React,
// reached the bridge, and can call into Rust from a remote origin.
const SIGNALS = {
  "interface reached the bridge": false,   // workspaceBootstrap
  "interface resolved its backend": false, // openworkServerInfo
  "remote-origin IPC into Rust": false,    // __ipcProbe, answered by Rust
};

function recordSignal(name) {
  if (SIGNALS[name] === false) {
    SIGNALS[name] = true;
    console.error(`[smoke] ${name}: ok`);
    if (Object.values(SIGNALS).every(Boolean)) finishSmoke(0, "all signals seen");
  }
}

let smokeDone = false;
function finishSmoke(code, reason) {
  if (!SMOKE || smokeDone) return;
  smokeDone = true;
  const report = {
    ok: code === 0,
    reason,
    platform: process.platform,
    signals: SIGNALS,
    unservedCommands: [...missing.keys()],
  };
  console.error(`[smoke] ${code === 0 ? "PASS" : "FAIL"} ${JSON.stringify(report)}`);
  try {
    writeFileSync(path.join(USER_DATA, "smoke.json"), JSON.stringify(report, null, 2));
  } catch {}
  if (serverChild) serverChild.kill();
  process.exit(code);
}

if (SMOKE) {
  setTimeout(() => {
    const waiting = Object.entries(SIGNALS).filter(([, seen]) => !seen).map(([name]) => name);
    finishSmoke(1, `timed out waiting for: ${waiting.join(", ")}`);
  }, SMOKE_TIMEOUT_MS).unref?.();
}

// --- HTTP -------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // The page is served by openwork-server on another port, so every call here
  // is cross-origin. Loopback only, and the bearer below is the real gate.
  const cors = {
    "access-control-allow-origin": `http://${SERVER_HOST}:${SERVER_PORT}`,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { ...cors, "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) return send(401, { error: "unauthorized" });

  if (req.url === "/meta") {
    return send(200, {
      desktopBootstrap: workspaceStore.readDesktopBootstrapConfigSync(),
      distribution,
      serverInfo: openworkServerInfo(),
    });
  }

  if (req.url === "/missing") {
    return send(200, { missing: [...missing.entries()].map(([name, count]) => ({ name, count })) });
  }

  if (req.url !== "/invoke" || req.method !== "POST") return send(404, { error: "not found" });

  let body;
  try { body = await readBody(req); } catch { return send(400, { error: "bad json" }); }

  const command = String(body?.command ?? "");
  const args = Array.isArray(body?.args) ? body.args : [];
  const handler = commands[command];

  if (!handler) {
    missing.set(command, (missing.get(command) ?? 0) + 1);
    const where = NATIVE_IN_RUST.has(command) ? "should have been handled in Rust" : "not implemented yet";
    console.error(`[bridge] ${command}: ${where}`);
    return send(501, { error: `Tauri desktop bridge: ${command} is ${where}` });
  }

  try {
    console.error(`[bridge] ${command}`);
    const value = await handler(...args);
    if (command === "workspaceBootstrap") recordSignal("interface reached the bridge");
    if (command === "openworkServerInfo") recordSignal("interface resolved its backend");
    return send(200, { value });
  } catch (error) {
    console.error(`[bridge] ${command} failed: ${error?.message ?? error}`);
    return send(500, { error: String(error?.message ?? error) });
  }
});

await writeServerConfig(path.join(USER_DATA, "server.json"));
startOpenworkServer();

server.listen(0, SERVER_HOST, () => {
  const { port } = server.address();
  const ready = { port, token: BRIDGE_TOKEN, appUrl: `http://${SERVER_HOST}:${SERVER_PORT}/` };
  // Rust reads this line to build the init script.
  console.log(`[bridge] ready ${JSON.stringify(ready)}`);
  // And a manifest on disk, so a running spike can be inspected without
  // reading the parent's stdout. Loopback only, inside the spike profile.
  writeFileSync(path.join(USER_DATA, "bridge.json"), JSON.stringify(ready, null, 2), { mode: 0o600 });
});

function shutdown() {
  if (serverChild) serverChild.kill();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
