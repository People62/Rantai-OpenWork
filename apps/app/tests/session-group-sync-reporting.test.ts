import { describe, expect, test } from "bun:test";

import {
  setSessionGroupSyncErrorReporter,
  setSessionGroupSyncHandler,
  useSessionManagementStore,
} from "../src/react-app/domains/session/sidebar/session-management-store";

const noopHandler = {
  createGroup: async () => null,
  assignGroup: async () => null,
  reorderGroups: async () => null,
  renameGroup: async () => null,
  removeGroup: async () => null,
};

/**
 * Group edits apply optimistically. Every path that fails to persist has to
 * reach the reporter, including the ones that never issue a request — those
 * were silent before and lost the user's arrangement without a trace.
 */
describe("session group sync reporting", () => {
  test("reports a handler that resolves null without sending a request", async () => {
    const seen: unknown[] = [];
    setSessionGroupSyncErrorReporter((error) => seen.push(error));
    setSessionGroupSyncHandler(noopHandler);

    useSessionManagementStore.getState().createGroup("ws_null_handler", "Group A");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen.length).toBe(1);
    setSessionGroupSyncErrorReporter(null);
    setSessionGroupSyncHandler(null);
  });

  test("reports when no sync handler is registered at all", async () => {
    const seen: unknown[] = [];
    setSessionGroupSyncErrorReporter((error) => seen.push(error));
    setSessionGroupSyncHandler(null);

    useSessionManagementStore.getState().createGroup("ws_no_handler", "Group B");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen.length).toBe(1);
    setSessionGroupSyncErrorReporter(null);
  });

  test("stays quiet when the handler succeeds", async () => {
    const seen: unknown[] = [];
    setSessionGroupSyncErrorReporter((error) => seen.push(error));
    setSessionGroupSyncHandler({
      ...noopHandler,
      createGroup: async () => ({ groups: [{ id: "grp_1", label: "Group C" }], assignments: {} }),
    });

    useSessionManagementStore.getState().createGroup("ws_ok", "Group C");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen.length).toBe(0);
    setSessionGroupSyncErrorReporter(null);
    setSessionGroupSyncHandler(null);
  });
});
