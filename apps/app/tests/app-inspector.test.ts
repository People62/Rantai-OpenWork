import { afterAll, describe, expect, test } from "bun:test";

import {
  ensureInspectorInstalled,
  publishInspectorOpencodeClient,
} from "../src/app/lib/app-inspector";
import { createClient } from "../src/app/lib/opencode";

// Globals replaced here leak into every later test file in the same bun
// process, so the originals are captured and put back when this file ends.
const __original_window = Object.getOwnPropertyDescriptor(globalThis, "window");
afterAll(() => {
  if (__original_window) Object.defineProperty(globalThis, "window", __original_window);
  else delete (globalThis as Record<string, unknown>).window;
});


describe("app inspector OpenCode client", () => {
  test("tracks the latest published client and clears it safely", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    ensureInspectorInstalled();

    const first = createClient("http://127.0.0.1:3000");
    const second = createClient("http://127.0.0.1:3001");
    const disposeFirst = publishInspectorOpencodeClient(first);
    const disposeSecond = publishInspectorOpencodeClient(second);

    expect(window.__openwork?.opencode).toBe(second);
    disposeFirst();
    expect(window.__openwork?.opencode).toBe(second);
    disposeSecond();
    expect(window.__openwork?.opencode).toBeNull();
  });
});
