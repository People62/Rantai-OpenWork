// Process-tree memory, sampled the same way on all three platforms.
//
// RSS, not PSS: /proc is a Linux luxury, and a comparison is only worth
// anything if both sides are measured identically. Shared pages therefore
// count once per process, which flatters neither shell in particular — both
// Electron and a Chromium-backed WebView2 pay it the same way.

import { execFileSync } from "node:child_process";

// WKWebView does not run the page inside the app. It runs it in XPC services
// that launchd owns, so they are not descendants of anything we spawned and a
// tree walk misses them completely — the first macOS run reported 154 MB and no
// webview at all. They have to be found by name instead.
const MAC_OUT_OF_TREE = /^com\.apple\.WebKit\./;

function readProcessTable() {
  if (process.platform === "win32") {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name) | ConvertTo-Json -Compress",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      kb: Math.round((row.WorkingSetSize ?? 0) / 1024),
      name: row.Name,
    }));
  }

  const out = execFileSync("ps", ["-Ao", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        kb: Number(match[3]),
        // ps reports the full path for XPC services; the leaf is the name.
        name: match[4].split("/").pop(),
      });
    }
  }
  return rows;
}

/** Every pid descending from root, root included. */
export function treePids(rows, root) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  return found;
}

/**
 * @param root      pid the measured application was started as
 * @param ignorePid pid whose direct children are measurement artefacts (the
 *                  ps/powershell this very function spawns)
 */
export function sampleProcessTree(root, { ignorePid = process.pid } = {}) {
  let rows;
  try {
    rows = readProcessTable();
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const inTree = new Set(treePids(rows, root));

  const samplerNames = new Set(["ps", "powershell", "powershell.exe", "conhost.exe"]);
  const picked = [];
  let byName = 0;

  for (const row of rows) {
    const isSampler = row.ppid === ignorePid && samplerNames.has(row.name);
    if (isSampler) continue;

    if (inTree.has(row.pid)) {
      picked.push({ ...row, how: "tree" });
    } else if (process.platform === "darwin" && MAC_OUT_OF_TREE.test(row.name)) {
      // Safe on a CI runner, where nothing else is running a webview. On a
      // developer machine this can catch another application's WebKit.
      picked.push({ ...row, how: "name" });
      byName += 1;
    }
  }

  picked.sort((a, b) => b.kb - a.kb);
  return {
    unit: "MB, RSS",
    totalMb: Math.round(picked.reduce((sum, row) => sum + row.kb, 0) / 1024),
    processCount: picked.length,
    attributedByName: byName,
    processes: picked.map((row) => ({
      name: row.name,
      mb: Math.round(row.kb / 1024),
      ...(row.how === "name" ? { foundBy: "name" } : {}),
    })),
  };
}

/** Kills the whole tree; a bare kill on the root strands the webview. */
export function killTree(root) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(root)], { stdio: "ignore" });
    } catch { /* already gone */ }
    return;
  }
  let pids = [root];
  try {
    pids = treePids(readProcessTable(), root);
  } catch { /* fall back to the root alone */ }
  for (const pid of pids.reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
