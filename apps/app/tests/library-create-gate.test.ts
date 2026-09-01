import { describe, expect, test } from "bun:test";

import { libraryCreateBlockReason } from "../src/react-app/domains/settings/state/library-create-gate";

describe("libraryCreateBlockReason", () => {
  test("asks for sign-in only when there is no token", () => {
    expect(libraryCreateBlockReason({ authToken: "", activeOrgId: "" })).toBe("sign-in");
    expect(libraryCreateBlockReason({ authToken: null, activeOrgId: "org_1" })).toBe("sign-in");
    expect(libraryCreateBlockReason({ authToken: "   ", activeOrgId: "org_1" })).toBe("sign-in");
  });

  test("asks for an organization when signed in without one", () => {
    // The case that sent a signed-in user back to the sign-in screen.
    expect(libraryCreateBlockReason({ authToken: "tok", activeOrgId: "" })).toBe("choose-organization");
    expect(libraryCreateBlockReason({ authToken: "tok", activeOrgId: null })).toBe("choose-organization");
    expect(libraryCreateBlockReason({ authToken: "tok", activeOrgId: "  " })).toBe("choose-organization");
  });

  test("allows the create when both are present", () => {
    expect(libraryCreateBlockReason({ authToken: "tok", activeOrgId: "org_1" })).toBe(null);
  });
});
