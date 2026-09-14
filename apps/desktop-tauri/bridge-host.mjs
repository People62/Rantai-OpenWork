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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { sampleProcessTree } from "./memory.mjs";
import {
  createConnectLinkReplayGuard,
  extractConnectExchange,
  resolveConnectExchangeUrl,
  verifyConnectLinkUrl,
} from "../desktop/electron/connect-link.mjs";
import { persistConnectLinkBranding } from "../desktop/electron/connect-link-branding.mjs";
import { resolveConnectLinkPublicKeys } from "../desktop/electron/connect-link-keys.mjs";
import { createRuntimeManager } from "../desktop/electron/runtime.mjs";
import { createWorkspaceStore } from "../desktop/electron/workspace-store.mjs";
// The server already owns skill CRUD, and bun imports TypeScript directly — so
// this reuses a proper module instead of extracting one out of main.mjs.
import { deleteCommand, listCommands, upsertCommand } from "../server/src/commands.ts";
import { deleteSkill, listSkills, upsertSkill } from "../server/src/skills.ts";
import { resolveDesktopDistribution } from "../desktop/electron/desktop-distribution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const SERVER_HOST = "127.0.0.1";

// Smoke mode: run unattended, decide whether the webview actually brought the
// interface up, and exit with a status CI can read. The gate this answers is
// stage 1's — does apps/app render in this platform's webview — which only
// WebKitGTK had ever been checked against.
const SMOKE = process.env.RANTAI_SPIKE_SMOKE === "1";
const SMOKE_TIMEOUT_MS = Number(process.env.RANTAI_SPIKE_SMOKE_TIMEOUT_MS ?? 120000);
// The webview keeps allocating for a while after the interface first responds
// — WebKitGTK was seen going from 417 MB to 615 MB inside a few seconds. A
// single early sample is not a number worth comparing across platforms, so the
// run settles first.
const SMOKE_SETTLE_MS = Number(process.env.RANTAI_SPIKE_SETTLE_MS ?? 25000);
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

/// The desktop bridge says "project"; the server module says "workspace".
function commandScope(raw) {
  return String(raw ?? "").trim() === "global" ? "global" : "workspace";
}

/// main.mjs refuses anything that is not kebab-case before touching the disk,
/// because the name becomes a directory. Same rule here.
function skillNameGuard(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

async function ensureSkillsDir(projectDir) {
  const root = String(projectDir ?? "").trim();
  if (!root) throw new Error("projectDir is required");
  const dir = path.join(root, ".opencode", "skills");
  await mkdir(dir, { recursive: true });
  return dir;
}

// --- the managed openwork-server -------------------------------------------

/// The real runtime manager, instead of the hand-rolled server this spike
/// started with.
///
/// runtime.mjs is 2,304 lines and touches exactly two Electron APIs —
/// app.getPath and app.isPackaged — so the same shim that carries
/// workspace-store carries this. What it brings is everything the spike was
/// faking: engine lifecycle, the managed opencode binary, port stickiness,
/// certificate handling, and a lock that serialises start/stop/restart so
/// concurrent calls do not kill each other's servers.
///
/// It also runs openwork-server in-process, the way Electron does, which drops
/// one of the two bun processes the memory measurements counted.
const runtimeManager = createRuntimeManager({
  app: fakeApp,
  desktopRoot: path.join(ROOT, "apps/desktop"),
  listLocalWorkspacePaths: () => workspaceStore.listLocalWorkspacePaths(),
});

// static-ui.ts reads the web root from the environment rather than an option,
// so this has to be set before the embedded server starts.
process.env.OPENWORK_WEB_ROOT = path.join(ROOT, "apps/app/dist");

/// Electron starts the engine when the interface asks. The spike starts it at
/// boot, because nothing here drives onboarding.
async function startRuntime() {
  const workspaces = await workspaceStore.listLocalWorkspacePaths();
  const projectDir = workspaces[0] ?? ROOT;
  try {
    await runtimeManager.engineStart(projectDir, {});
    const info = await runtimeManager.openworkServerInfo();
    console.error(`[bridge] runtime up on ${info.baseUrl ?? "(no url)"}`);
    return info;
  } catch (error) {
    // Nothing downstream works without a server, and reporting ready with a
    // null url only moves the failure somewhere less legible: Rust answered the
    // first version of this with a serde type error rather than the cause.
    console.error(`[bridge] engineStart failed: ${error?.message ?? error}`);
    console.error("[bridge] the embedded server bundle is built by `pnpm --filter @openwork/server build`");
    process.exit(1);
  }
}


// --- deep links ---------------------------------------------------------------

// All 497 lines of connect-link.mjs are plain Node — signature checks, claim
// extraction, the replay ledger. None of it is rewritten here; Rust only has to
// register the scheme and hand the URL over.

const replayGuard = createConnectLinkReplayGuard({
  filePath: path.join(USER_DATA, "connect-link-seen.json"),
});

function verifyConnectLink(rawUrl) {
  return verifyConnectLinkUrl(String(rawUrl ?? ""), {
    publicKeys: resolveConnectLinkPublicKeys(),
    allowInsecureLoopback: false,
  });
}

// Electron passes its own net.fetch here, which rides Chromium's network stack
// and so picks up the system proxy and certificate store. Node's fetch does
// neither. It is enough for the spike and wrong for a release.
async function resolveConnectLink(rawUrl, mode) {
  if (extractConnectExchange(rawUrl)) {
    return resolveConnectExchangeUrl(rawUrl, { mode, fetcher: fetch, allowInsecureLoopback: false });
  }
  return verifyConnectLink(rawUrl);
}

const REPLAYED = {
  ok: false,
  code: "replayed",
  message: "This connect link was already used on this machine.",
};

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

  // --- skills ---------------------------------------------------------------

  listLocalSkills: (projectDir) => listSkills(String(projectDir ?? "").trim(), true),

  readLocalSkill: async (projectDir, name) => {
    const root = String(projectDir ?? "").trim();
    const skills = await listSkills(root, true);
    const found = skills.find((s) => s.name === name);
    if (!found) throw new Error(`Skill not found: ${name}`);
    // listSkills already returns the SKILL.md path, not the directory holding
    // it. Joining "SKILL.md" onto it again is how this first went wrong.
    return { path: found.path, content: await readFile(found.path, "utf8") };
  },

  writeLocalSkill: async (projectDir, name, content) => {
    const result = await upsertSkill(String(projectDir ?? "").trim(), { name, content });
    return { ok: true, status: 0, stdout: `Saved skill ${name} to ${result.path}`, stderr: "" };
  },

  uninstallSkill: async (projectDir, name) => {
    const result = await deleteSkill(String(projectDir ?? "").trim(), String(name ?? "").trim());
    return { ok: true, status: 0, stdout: `Removed skill ${name} from ${result.path}`, stderr: "" };
  },

  // A skill is a folder, and importing one is a recursive copy — the same eight
  // lines main.mjs runs. Worth keeping identical: this is how a knowledge base
  // gets in.
  importSkill: async (projectDir, sourceDir, options = {}) => {
    const root = skillNameGuard(path.basename(String(sourceDir ?? "").trim()));
    const destination = path.join(await ensureSkillsDir(projectDir), root);
    if (existsSync(destination)) {
      if (options.overwrite !== true) {
        return { ok: false, status: 1, stdout: "", stderr: `Skill already exists at ${destination}` };
      }
      await rm(destination, { recursive: true, force: true });
    }
    await cp(String(sourceDir).trim(), destination, { recursive: true });
    return { ok: true, status: 0, stdout: `Imported skill to ${destination}`, stderr: "" };
  },

  installSkillTemplate: async (projectDir, name, content, options = {}) => {
    const safe = skillNameGuard(name);
    const destination = path.join(await ensureSkillsDir(projectDir), safe);
    if (existsSync(destination) && options.overwrite !== true) {
      return { ok: false, status: 1, stdout: "", stderr: `Skill already exists at ${destination}` };
    }
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), String(content ?? ""), "utf8");
    return { ok: true, status: 0, stdout: `Installed skill to ${destination}`, stderr: "" };
  },

  // --- opencode commands ------------------------------------------------------

  // The server's own module again. It takes "workspace" | "global" where the
  // desktop bridge says "project"; the interface sends the desktop spelling.
  opencodeCommandList: (input = {}) =>
    listCommands(String(input.projectDir ?? "").trim(), commandScope(input.scope)),

  opencodeCommandWrite: (input = {}) =>
    upsertCommand(String(input.projectDir ?? "").trim(), input.command ?? {}),

  opencodeCommandDelete: (input = {}) =>
    deleteCommand(String(input.projectDir ?? "").trim(), String(input.name ?? "").trim()),

  // --- workspace config -------------------------------------------------------

  workspaceExportConfig: (input) => workspaceStore.exportConfig(input ?? {}),
  workspaceImportConfig: (input) => workspaceStore.importConfig(input ?? {}),

  connectLinkVerify: async (rawUrl) => {
    const verified = await resolveConnectLink(String(rawUrl ?? ""), "preview");
    if (verified.ok === false) return verified;
    // Refuse a spent link before the user is ever shown a confirmation.
    if (verified.transport === "signed" && (await replayGuard.has(verified.claims.jti))) return REPLAYED;
    return verified;
  },

  connectLinkAccept: async (rawUrl) => {
    // The page hands back the raw URL after confirming; claims shaped there are
    // never trusted, so this verifies again from scratch.
    const verified = await resolveConnectLink(String(rawUrl ?? ""), "exchange");
    if (verified.ok === false) return verified;

    if (verified.transport !== "exchange") {
      if (await replayGuard.has(verified.claims.jti)) return REPLAYED;
      // Consume before mutating. If the ledger cannot be written, fail closed
      // and leave the existing bootstrap alone.
      if (!(await replayGuard.remember(verified.claims.jti))) return REPLAYED;
    }

    const config = await persistConnectLinkBranding(verified.claims, {
      persistBootstrap: (next) => workspaceStore.setDesktopBootstrapConfig(next),
      // Applying the brand icon needs a native image; the spike skips it, which
      // costs a logo and nothing else.
      applyBrandIconUrl: async () => {},
    });
    return { ok: true, config };
  },

  runtimeBootstrap: () => ({ ok: true, openworkServer: openworkServerInfo() }),
  runtimeStatus: () => ({ ok: true, openworkServer: openworkServerInfo() }),

  // --- engine and runtime -----------------------------------------------------

  engineInfo: () => runtimeManager.engineInfo(),
  runtimeStatus: () => runtimeManager.runtimeStatus(),
  runtimeBootstrap: () => runtimeManager.runtimeStatus(),
  engineStart: (projectDir, options) => runtimeManager.engineStart(String(projectDir ?? "").trim(), options ?? {}),
  engineStop: () => runtimeManager.engineStop(),
  engineRestart: (options) => runtimeManager.engineRestart(options ?? {}),
  engineDoctor: (input) => runtimeManager.engineDoctor(input),
  engineInstall: () => runtimeManager.engineInstall(),
  prepareFreshRuntime: () => runtimeManager.prepareFreshRuntime(),
  opencodeMcpAuth: (name) => runtimeManager.opencodeMcpAuth(String(name ?? "").trim()),
  sandboxCleanupOpenworkContainers: () => runtimeManager.sandboxCleanupOpenworkContainers(),
  openworkServerInfo: () => runtimeManager.openworkServerInfo(),
  openworkServerRestart: (options) => runtimeManager.openworkServerRestart(options ?? {}),

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

  __integrationProbeResult: (result) => {
    console.error(`[bridge] integration probe: ${JSON.stringify(result)}`);
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
    if (Object.values(SIGNALS).every(Boolean)) {
      console.error(`[smoke] all signals seen; settling ${SMOKE_SETTLE_MS}ms before measuring`);
      setTimeout(() => finishSmoke(0, "all signals seen"), SMOKE_SETTLE_MS);
    }
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
    // Only meaningful once the interface is actually up, which is what a
    // passing run means; a timed-out run measures a half-built window.
    // Rooted at the parent, because that is the Tauri process: this host is
    // its child and the webview is its sibling.
    memory: code === 0 ? sampleProcessTree(process.ppid) : null,
  };
  console.error(`[smoke] ${code === 0 ? "PASS" : "FAIL"} ${JSON.stringify(report)}`);
  try {
    writeFileSync(path.join(USER_DATA, "smoke.json"), JSON.stringify(report, null, 2));
  } catch {}
  runtimeManager.dispose().catch(() => {});
  process.exit(code);
}

if (SMOKE) {
  setTimeout(() => {
    const waiting = Object.entries(SIGNALS).filter(([, seen]) => !seen).map(([name]) => name);
    finishSmoke(1, `timed out waiting for: ${waiting.join(", ")}`);
  }, SMOKE_TIMEOUT_MS).unref?.();
}

// --- HTTP -------------------------------------------------------------------

/// Echoes an Origin header only when it is loopback, so a stray page on the
/// wider network cannot talk its way past CORS.
function loopbackOrigin(origin) {
  if (typeof origin !== "string" || !origin) return null;
  try {
    const { hostname, protocol } = new URL(origin);
    const local = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    return local && protocol === "http:" ? origin : null;
  } catch {
    return null;
  }
}

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
    // The page's port is chosen by the runtime manager, so the origin is
    // echoed back when it is loopback rather than pinned to one number. The
    // bearer below is the actual gate; this only satisfies the browser.
    "access-control-allow-origin": loopbackOrigin(req.headers.origin) ?? "null",
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
      serverInfo: await runtimeManager.openworkServerInfo(),
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

const runtimeInfo = await startRuntime();

server.listen(0, SERVER_HOST, () => {
  const { port } = server.address();
  // The runtime manager chooses the port, so the window is told where the
  // server actually landed rather than where the spike used to put it.
  const appUrl = runtimeInfo?.baseUrl ? `${runtimeInfo.baseUrl.replace(/\/$/, "")}/` : null;
  const ready = { port, token: BRIDGE_TOKEN, appUrl };
  // Rust reads this line to build the init script.
  console.log(`[bridge] ready ${JSON.stringify(ready)}`);
  // And a manifest on disk, so a running spike can be inspected without
  // reading the parent's stdout. Loopback only, inside the spike profile.
  writeFileSync(path.join(USER_DATA, "bridge.json"), JSON.stringify(ready, null, 2), { mode: 0o600 });
});

function shutdown() {
  runtimeManager.dispose().catch(() => {});
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
