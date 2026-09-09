// Takes a picture of the running desktop app.
//
// Design changes are the one kind of change a test suite cannot check. Three of
// them reached main before anyone looked at the result, and the last one turned
// out to have almost no effect at all — --font-heading was pointed at a real
// typeface, but nothing on screen asked for that token, so the font never
// loaded. A screenshot would have said so in seconds.
//
// Electron already opens a DevTools endpoint, and voice-cdp.mjs already drives
// the app through it. This does the same thing for one frame.
//
//   node scripts/screenshot.mjs out.png
//   node scripts/screenshot.mjs settings.png --eval 'window.dispatchEvent(new Event("openwork:native-menu:open-settings"))'
//
// On a machine with no display, run the app under Xvfb first:
//
//   xvfb-run -a -s "-screen 0 1440x900x24" \
//     "$(cd apps/desktop && node -p "require('electron')")" apps/desktop/electron/main.mjs
//
// Electron takes the first free port from 9222 upwards, so the endpoint moves
// when an earlier instance is still around; --cdp pins it when that matters.

import { writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const out = args._[0] ?? "screenshot.png";
const settleMs = Number(args.settle ?? 4000);
const timeoutMs = Number(args.timeout ?? 60000);

const endpoint = args.cdp ?? (await discoverEndpoint());
const target = await waitForPage(endpoint);
console.error(`[screenshot] ${target.title || target.url}`);

const client = await connect(target.webSocketDebuggerUrl);
try {
  if (args.eval) {
    const result = await client.send("Runtime.evaluate", {
      expression: args.eval,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`--eval threw: ${result.exceptionDetails.text}`);
    }
    console.error(`[screenshot] eval -> ${JSON.stringify(result.result?.value ?? null)}`);
  }

  // The interface animates in, and fonts load after first paint; a picture
  // taken immediately shows neither.
  await sleep(settleMs);

  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.error(`[screenshot] wrote ${out}`);
} finally {
  client.close();
}

// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
    else args._.push(arg);
  }
  return args;
}


/** Electron picks the first free port from 9222; find the one answering. */
async function discoverEndpoint() {
  for (let port = 9222; port <= 9231; port += 1) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return url;
    } catch { /* nothing there */ }
  }
  throw new Error("no DevTools endpoint on 9222-9231 — is the app running?");
}

async function waitForPage(endpoint) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${endpoint}/json/list`).then((r) => r.json());
      // The built-in browser panel opens targets of its own; the main window is
      // the one serving the interface itself.
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"),
      );
      if (page) return page;
    } catch { /* still starting */ }
    await sleep(500);
  }
  throw new Error(`no page target on ${endpoint} within ${timeoutMs}ms`);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;

    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const id = ++nextId;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        close: () => socket.close(),
      }),
    );
    socket.addEventListener("error", () =>
      reject(new Error(`cannot open ${webSocketDebuggerUrl}`)),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.rej(new Error(message.error.message));
      else entry.res(message.result);
    });
  });
}
