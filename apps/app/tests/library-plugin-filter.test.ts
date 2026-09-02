import { describe, expect, test } from "bun:test";

import {
  libraryPluginMatchesFilter,
  type LibraryPluginFileRef,
} from "../src/react-app/domains/settings/library";

const file = (objectType: string): LibraryPluginFileRef => ({
  configObjectId: `cfg_${objectType}`,
  objectType,
  title: objectType,
});

/** Stands in for matchesExtensionFilter bound to one selected filter. */
const forFilter = (filter: string) => (kind: string) => filter === "all" || filter === kind;

describe("libraryPluginMatchesFilter", () => {
  test("an agent plugin shows under the Agents filter", () => {
    // The reported case: created with "Add agent", stored as a plugin,
    // previously invisible under Agents.
    expect(libraryPluginMatchesFilter([file("agent")], forFilter("agent"))).toBe(true);
  });

  test("still shows under the Plugins filter", () => {
    expect(libraryPluginMatchesFilter([file("agent")], forFilter("plugin"))).toBe(true);
  });

  test("and under All", () => {
    expect(libraryPluginMatchesFilter([file("agent")], forFilter("all"))).toBe(true);
  });

  test("does not leak into unrelated categories", () => {
    expect(libraryPluginMatchesFilter([file("agent")], forFilter("skill"))).toBe(false);
    expect(libraryPluginMatchesFilter([file("agent")], forFilter("command"))).toBe(false);
  });

  test("a bundle matches every category it carries", () => {
    const bundle = [file("agent"), file("skill")];
    expect(libraryPluginMatchesFilter(bundle, forFilter("agent"))).toBe(true);
    expect(libraryPluginMatchesFilter(bundle, forFilter("skill"))).toBe(true);
    expect(libraryPluginMatchesFilter(bundle, forFilter("command"))).toBe(false);
  });

  test("unknown component types are ignored", () => {
    expect(libraryPluginMatchesFilter([file("hook")], forFilter("agent"))).toBe(false);
    expect(libraryPluginMatchesFilter([file("hook")], forFilter("plugin"))).toBe(true);
  });

  test("an empty bundle still matches only Plugins", () => {
    expect(libraryPluginMatchesFilter([], forFilter("plugin"))).toBe(true);
    expect(libraryPluginMatchesFilter([], forFilter("agent"))).toBe(false);
  });
});
