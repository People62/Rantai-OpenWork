declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import { platformCapabilities } from "./platform-capabilities";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function setElectronRuntime(enabled: boolean) {
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  }
  // isElectronRuntime() reads the flag off `window`, and `window` is not
  // always globalThis: bun runs every test file in one process, so another
  // file may have installed its own window object first. Setting the flag on
  // globalThis would then land on an object nobody reads.
  Object.defineProperty(window, "__OPENWORK_ELECTRON__", {
    value: enabled ? {} : undefined,
    configurable: true,
  });
}

function restoreRuntime() {
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "__OPENWORK_ELECTRON__", { value: undefined, configurable: true });
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else if (typeof window !== "undefined") {
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  }
}

describe("platformCapabilities", () => {
  test("returns false for every capability outside Electron", () => {
    setElectronRuntime(false);
    expect(platformCapabilities()).toEqual({
      nativeFilePicker: false,
      revealInFileManager: false,
      terminal: false,
      autoUpdate: false,
      osNotifications: false,
      localRuntimeControl: false,
      desktopBootstrap: false,
    });
    restoreRuntime();
  });

  test("returns true for every capability in Electron", () => {
    setElectronRuntime(true);
    expect(platformCapabilities()).toEqual({
      nativeFilePicker: true,
      revealInFileManager: true,
      terminal: true,
      autoUpdate: true,
      osNotifications: true,
      localRuntimeControl: true,
      desktopBootstrap: true,
    });
    restoreRuntime();
  });
});
