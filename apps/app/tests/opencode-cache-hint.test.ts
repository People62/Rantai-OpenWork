import { describe, expect, test } from "bun:test";

import { addOpencodeCacheHint, opencodeCacheRootFromMessage } from "../src/app/utils";

describe("opencodeCacheRootFromMessage", () => {
  test("reads the cache directory out of a Linux ENOENT", () => {
    expect(opencodeCacheRootFromMessage(
      "ENOENT: no such file or directory, open '/home/sam/.cache/opencode/fetch_jwks.js'",
    )).toBe("/home/sam/.cache/opencode");
  });

  test("reads it out of a macOS path", () => {
    expect(opencodeCacheRootFromMessage(
      "ENOENT: open /Users/sam/Library/Caches/opencode/bin/tui failed",
    )).toBe("/Users/sam/Library/Caches/opencode");
  });

  test("reads it out of a Windows path", () => {
    expect(opencodeCacheRootFromMessage(
      "ENOENT: C:\\Users\\Sam\\AppData\\Local\\opencode\\cache.db is missing",
    )).toBe("C:\\Users\\Sam\\AppData\\Local\\opencode");
  });

  test("returns null when the error names no cache path", () => {
    expect(opencodeCacheRootFromMessage("ENOENT: opencode cache is unreadable")).toBeNull();
  });
});

describe("addOpencodeCacheHint", () => {
  test("names the directory the error itself reported", () => {
    const hinted = addOpencodeCacheHint(
      "ENOENT: no such file or directory, open '/home/sam/.cache/opencode/fetch_jwks.js'",
    );

    expect(hinted).toContain("Delete /home/sam/.cache/opencode and restart OpenWork");
  });

  test("never sends people to the disabled Repair cache action", () => {
    const hinted = addOpencodeCacheHint(
      "ENOENT: no such file or directory, open '/home/sam/.cache/opencode/fetch_jwks.js'",
    );

    expect(hinted).not.toContain("Repair cache");
    expect(hinted).not.toContain("Settings");
  });

  test("falls back to the platform location when the error names no path", () => {
    const message = "ENOENT: opencode cache is unreadable";

    expect(addOpencodeCacheHint(message, "windows")).toContain("Delete %LOCALAPPDATA%\\opencode");
    expect(addOpencodeCacheHint(message, "mac")).toContain("Delete ~/Library/Caches/opencode");
    expect(addOpencodeCacheHint(message, "other")).toContain("Delete ~/.cache/opencode");
  });

  test("keeps the original message ahead of the hint", () => {
    const message = "ENOENT: no such file or directory, open '/home/sam/.cache/opencode/x'";

    expect(addOpencodeCacheHint(message).startsWith(`${message}\n\n`)).toBe(true);
  });

  test("leaves unrelated errors untouched", () => {
    expect(addOpencodeCacheHint("Request timed out.")).toBe("Request timed out.");
  });

  test("leaves a cache path alone when the error is not ENOENT", () => {
    const message = "EACCES: permission denied, open '/home/sam/.cache/opencode/x'";

    expect(addOpencodeCacheHint(message)).toBe(message);
  });
});
