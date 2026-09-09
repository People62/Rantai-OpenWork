// Runs one desktop shell and reports what it costs, so Tauri and Electron can
// be compared on the same machine with the same metric.
//
// Why a fixed point in time rather than "once the app is ready": readiness is
// not detectable the same way on both sides. The Tauri spike reports its own
// signals through the bridge; Electron has no such channel, and the files it
// writes on startup are empty until a workspace exists. Any per-shell readiness
// probe would measure the two at different moments, which is exactly the flaw
// that makes a comparison worthless. Identical treatment beats a cleverer
// trigger: both shells get the same number of seconds from launch.
//
// The number itself is RSS and it double-counts shared pages. That is a real
// weakness in isolation and a harmless one here, because it applies to both
// sides equally.
//
//   node measure.mjs --label electron --after 90 -- pnpm exec electron ./electron/main.mjs

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sampleProcessTree, killTree } from "./memory.mjs";

function parseArgs(argv) {
  const options = { label: "shell", afterSeconds: 90, cwd: process.cwd(), out: null };
  const command = [];
  let rest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (rest) { command.push(arg); continue; }
    if (arg === "--") { rest = true; continue; }
    if (arg === "--label") { options.label = argv[++i]; continue; }
    if (arg === "--after") { options.afterSeconds = Number(argv[++i]); continue; }
    if (arg === "--cwd") { options.cwd = argv[++i]; continue; }
    if (arg === "--out") { options.out = argv[++i]; continue; }
    throw new Error(`unknown option: ${arg}`);
  }

  if (!command.length) throw new Error("nothing to measure: pass the command after --");
  return { options, command };
}

const { options, command } = parseArgs(process.argv.slice(2));

console.error(`[measure] ${options.label}: ${command.join(" ")}`);
console.error(`[measure] sampling ${options.afterSeconds}s after launch`);

// Electron reads this and runs as a plain Node REPL instead of starting the
// application. It is set inside some agent environments, and it cost a whole
// measurement round before it was spotted.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(command[0], command.slice(1), {
  cwd: options.cwd,
  stdio: ["ignore", "inherit", "inherit"],
  env: childEnv,
});

let exitedEarly = null;
child.on("exit", (code, signal) => { exitedEarly = { code, signal }; });

// Without this, a bad command surfaces as "Error: spawn <whatever the shell
// captured>" with no hint that the path itself is wrong — which is exactly how
// a stray "Downloading Electron binary..." on stdout read as a file path.
child.on("error", (error) => {
  console.error(`[measure] cannot start ${command[0]}: ${error.message}`);
  if (error.code === "ENOENT") {
    console.error("[measure] that is the command, not its output — check how the path was resolved");
  }
  process.exit(1);
});

await new Promise((resolve) => setTimeout(resolve, options.afterSeconds * 1000));

const report = {
  label: options.label,
  platform: process.platform,
  afterSeconds: options.afterSeconds,
  command: command.join(" "),
  // A shell that died before the sample was never measured; saying so beats
  // publishing the memory of a process that is not there.
  survived: exitedEarly === null,
  exitedEarly,
  memory: exitedEarly === null ? sampleProcessTree(child.pid) : null,
};

console.log(JSON.stringify(report, null, 2));

if (options.out) {
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, JSON.stringify(report, null, 2));
}

killTree(child.pid);

// A shell that could not stay up for the measurement window is a failure worth
// failing on; the memory it did not use is not a result.
process.exit(report.survived ? 0 : 1);
