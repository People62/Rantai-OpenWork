/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
};

import { renderToStaticMarkup } from "react-dom/server";

import type { DenOrgSummary } from "../../../app/lib/den";
import {
  OrganizationList,
  initialOrgOnboardingSelectionState,
  resolveOrgOnboardingPostListStep,
} from "./org-onboarding-page";

function org(id: string, name: string): DenOrgSummary {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    role: "member",
  };
}

describe("org onboarding organization choice", () => {
  test("keeps a recent handoff unselected so two orgs render the chooser", () => {
    const currentOrg = org("org-current", "Acme Robotics");
    const otherOrg = org("org-other", "Beta Labs");
    const initial = initialOrgOnboardingSelectionState();
    const step = resolveOrgOnboardingPostListStep({
      orgs: [currentOrg, otherOrg],
      activeOrgId: currentOrg.id,
      hasActiveOrganization: true,
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(step.kind).toBe("choose-org");
    const markup = renderToStaticMarkup(
      <OrganizationList
        orgs={[currentOrg, otherOrg]}
        value={currentOrg}
        onValueChange={() => {}}
      />,
    );
    expect(markup).toContain("Acme Robotics");
    expect(markup).toContain("Beta Labs");
  });

  test("auto-selects and auto-continues resources for one org", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const initial = initialOrgOnboardingSelectionState();
    const autoSelectStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: "",
      hasActiveOrganization: false,
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(autoSelectStep).toEqual({
      kind: "auto-select-single-org",
      organization: soloOrg,
    });

    const resourceStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasActiveOrganization: true,
      hasSelectedOrganization: true,
      autoContinueResources: true,
      autoSelectFailedOrgId: null,
    });

    expect(resourceStep).toEqual({ kind: "resources", autoContinue: true });
  });

  test("shows the chooser for two orgs without a handoff", () => {
    const firstOrg = org("org-first", "First Workspace");
    const activeOrg = org("org-active", "Active Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [firstOrg, activeOrg],
      activeOrgId: activeOrg.id,
      hasActiveOrganization: true,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: null,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: activeOrg,
    });
  });

  test("falls back to the chooser when single-org auto-selection failed", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasActiveOrganization: true,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: soloOrg.id,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: soloOrg,
    });
  });

  test("reports no organizations when the list is empty and none is active", () => {
    // The loop we fixed came from here: an empty list fell through to the
    // resources step, whose queries are keyed by organization id and stay
    // disabled forever, so the page never resolved.
    expect(
      resolveOrgOnboardingPostListStep({
        orgs: [],
        activeOrgId: "",
        hasActiveOrganization: false,
        hasSelectedOrganization: false,
        autoContinueResources: false,
        autoSelectFailedOrgId: null,
      }),
    ).toEqual({ kind: "no-organizations" });
  });

  test("still shows resources for an empty list once an organization is active", () => {
    // A transient empty read must not evict someone who already picked one.
    expect(
      resolveOrgOnboardingPostListStep({
        orgs: [],
        activeOrgId: "org_1",
        hasActiveOrganization: true,
        hasSelectedOrganization: true,
        autoContinueResources: false,
        autoSelectFailedOrgId: null,
      }),
    ).toEqual({ kind: "resources", autoContinue: true });
  });

  test("a handoff suggestion alone does not count as an active organization", () => {
    // The resources step reads the stored active id, not the suggestion, so
    // treating a suggestion as active renders that step against an empty id
    // and revives the redirect loop this branch exists to prevent.
    expect(
      resolveOrgOnboardingPostListStep({
        orgs: [],
        activeOrgId: "org_suggested",
        hasActiveOrganization: false,
        hasSelectedOrganization: false,
        autoContinueResources: false,
        autoSelectFailedOrgId: null,
      }).kind,
    ).toBe("no-organizations");
  });
});
