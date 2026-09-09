// Talking to the running desktop app over its DevTools endpoint.
//
// Shared by screenshot.mjs and contrast-audit.mjs: both need to find the app,
// attach to its window, and evaluate something inside it.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Electron picks the first free port from 9222; find the one answering. */
export async function discoverEndpoint() {
  for (let port = 9222; port <= 9231; port += 1) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return url;
    } catch { /* nothing there */ }
  }
  throw new Error("no DevTools endpoint on 9222-9231 — is the app running?");
}

export async function waitForPage(endpoint, timeoutMs = 60000) {
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

export function connect(webSocketDebuggerUrl) {
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
