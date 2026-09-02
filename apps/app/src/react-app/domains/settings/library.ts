/**
 * Library is the single inventory for composer capabilities.
 * Configure from the + menu, and the agents / commands / skills lists,
 * all resolve through this module so settings routes cannot drift.
 */
/** Unfiltered Library inventory. */
export const LIBRARY_ROUTE_PATH = "";

export const LIBRARY_COMPOSER_KINDS = ["agents", "commands", "skills"] as const;

export type LibraryComposerKind = (typeof LIBRARY_COMPOSER_KINDS)[number];

export type ComposerSettingsSection =
  | LibraryComposerKind
  | "mcps"
  | "plugins"
  | "connections"
  | "extensions"
  | "providers";

/** Fallback when Configure has no + menu section (opens the full inventory). */
export const COMPOSER_CONFIGURE_SECTION = "extensions" satisfies ComposerSettingsSection;

export function isLibraryComposerKind(section: string): section is LibraryComposerKind {
  return (LIBRARY_COMPOSER_KINDS as readonly string[]).includes(section);
}

/** Map a composer + menu pane onto the Library settings section. */
export function composerConfigureSectionForMenu(section: string): ComposerSettingsSection {
  if (section === "mcps") return "connections";
  if (
    section === "providers"
    || section === "extensions"
    || section === "plugins"
    || section === "connections"
  ) {
    return section;
  }
  if (isLibraryComposerKind(section)) return section;
  if (section.startsWith("plugin:")) return "plugins";
  return COMPOSER_CONFIGURE_SECTION;
}

/** URL tail under /extensions for a composer Configure destination. */
export function libraryPathForSection(section: ComposerSettingsSection): string {
  if (section === "providers" || section === "extensions") return LIBRARY_ROUTE_PATH;
  return section;
}

export const LIBRARY_COMMAND_DETAIL_PREFIX = "command:";
export const LIBRARY_AGENT_DETAIL_PREFIX = "agent:";

export type LibraryCommandItem = {
  id: string;
  name: string;
  description?: string;
  template?: string;
  hints?: string[];
  agent?: string;
  model?: string;
  subtask?: boolean;
};

export type LibraryAgentItem = {
  name: string;
  description?: string;
  prompt?: string;
  mode?: string;
  native?: boolean;
  model?: {
    providerID: string;
    modelID: string;
  };
};

export function libraryCommandDetailId(command: Pick<LibraryCommandItem, "id">) {
  return `${LIBRARY_COMMAND_DETAIL_PREFIX}${command.id}`;
}

export function libraryAgentDetailId(agent: Pick<LibraryAgentItem, "name">) {
  return `${LIBRARY_AGENT_DETAIL_PREFIX}${agent.name}`;
}

export function parseLibraryCommandDetailId(detailId: string) {
  if (!detailId.startsWith(LIBRARY_COMMAND_DETAIL_PREFIX)) return null;
  return detailId.slice(LIBRARY_COMMAND_DETAIL_PREFIX.length);
}

export function parseLibraryAgentDetailId(detailId: string) {
  if (!detailId.startsWith(LIBRARY_AGENT_DETAIL_PREFIX)) return null;
  return detailId.slice(LIBRARY_AGENT_DETAIL_PREFIX.length);
}

export function libraryCommandTriggers(command: LibraryCommandItem) {
  const slash = `/${command.name}`;
  const extras = (command.hints ?? []).map((hint) => hint.trim()).filter((hint) => hint.length > 0 && hint !== slash);
  return [slash, ...extras];
}

export function isLibraryCommand(command: { source?: string | null }) {
  return !command.source || command.source === "command";
}

export function isLibraryAgent(agent: { hidden?: boolean; mode?: string | null }) {
  return !agent.hidden && agent.mode !== "subagent";
}

export function libraryCommandsFromSlashOptions(
  commands: Array<{
    id: string;
    name: string;
    description?: string;
    source?: string | null;
    template?: string;
    hints?: string[];
    agent?: string;
    model?: string;
    subtask?: boolean;
  }>,
): LibraryCommandItem[] {
  return commands.filter(isLibraryCommand).map((command) => ({
    id: command.id,
    name: command.name,
    description: command.description,
    template: command.template,
    hints: command.hints,
    agent: command.agent,
    model: command.model,
    subtask: command.subtask,
  }));
}

export function libraryAgentsFromOpencode(
  agents: Array<{
    name: string;
    description?: string;
    hidden?: boolean;
    mode?: string | null;
    prompt?: string;
    native?: boolean;
    model?: { providerID: string; modelID: string };
  }>,
): LibraryAgentItem[] {
  return agents.filter(isLibraryAgent).map((agent) => ({
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    mode: agent.mode ?? undefined,
    native: agent.native,
    model: agent.model,
  }));
}

export type ComposerConfigureDestination =
  | { kind: "library"; path: string }
  | { kind: "settings"; route: "/settings/ai" };

/** Configure from the composer opens the matching Library filter, except providers. */
export function composerConfigureDestination(
  section: ComposerSettingsSection,
): ComposerConfigureDestination {
  if (section === "providers") return { kind: "settings", route: "/settings/ai" };
  return { kind: "library", path: libraryPathForSection(section) };
}

export function openComposerConfigure(
  section: ComposerSettingsSection,
  handlers: {
    openLibrary: (path?: string) => void;
    openSettings: (route: string) => void;
  },
) {
  const destination = composerConfigureDestination(section);
  if (destination.kind === "settings") {
    handlers.openSettings(destination.route);
    return;
  }
  handlers.openLibrary(destination.path);
}

export const LIBRARY_ADD_KINDS = ["skill", "command", "agent", "mcp", "plugin", "connection"] as const;

export type LibraryAddKind = (typeof LIBRARY_ADD_KINDS)[number];

export type LibraryAuthorableKind = Extract<LibraryAddKind, "skill" | "command" | "agent" | "plugin" | "mcp">;

const LIBRARY_ITEM_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Kinds the current Library filter can create. Built-in apps are not user-authored. */
export function libraryAddKindsForFilter(filter: string): LibraryAddKind[] {
  switch (filter) {
    case "all":
      return [...LIBRARY_ADD_KINDS];
    case "skill":
      return ["skill"];
    case "command":
      return ["command"];
    case "agent":
      return ["agent"];
    case "mcp":
      return ["mcp"];
    case "plugin":
      return ["plugin"];
    case "connection":
      return ["connection"];
    default:
      return [];
  }
}

export function isLibraryAuthorableKind(kind: LibraryAddKind): kind is LibraryAuthorableKind {
  return kind === "skill" || kind === "command" || kind === "agent" || kind === "plugin" || kind === "mcp";
}

export type LibraryAddAction =
  | { type: "den-url"; kind: "connection" }
  | { type: "den-modal"; kind: LibraryAuthorableKind };

/** Library Add always creates in OpenWork Cloud. Local workspace files are not an authoring path. */
export function libraryAddAction(
  addKind: LibraryAddKind,
  options: {
    cloudSignedIn: boolean;
  },
): LibraryAddAction | null {
  if (!options.cloudSignedIn) return null;
  if (addKind === "connection") return { type: "den-url", kind: "connection" };
  if (isLibraryAuthorableKind(addKind)) return { type: "den-modal", kind: addKind };
  return null;
}

export type LibraryPluginComponentKind = "skill" | "command" | "agent" | "mcp";

export type LibraryPluginComponentDraft = {
  kind: LibraryPluginComponentKind;
  name: string;
  description: string;
  content: string;
};

export type CreateLibraryItemInput = {
  name: string;
  description: string;
  instructions: string;
  orgWide?: boolean;
  marketplaceId?: string;
  components?: LibraryPluginComponentDraft[];
};

export type DenLibraryPluginCreateRequest = {
  name: string;
  description: string | null;
  orgWide?: boolean;
  marketplaceId?: string;
  components: Array<{
    type: LibraryPluginComponentKind;
    input: {
      rawSourceText?: string;
      normalizedPayloadJson?: Record<string, unknown>;
      metadata: { name: string; description?: string };
    };
  }>;
};

function skillMarkdown(name: string, description: string, instructions: string) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    instructions,
    "",
  ].join("\n");
}

export function denLibraryPluginComponentBody(component: LibraryPluginComponentDraft): DenLibraryPluginCreateRequest["components"][number] {
  const slug = slugifyLibraryItemName(component.name, component.kind === "mcp" ? "plugin" : component.kind);
  const description = component.description.trim();
  if (component.kind === "mcp") {
    return {
      type: "mcp",
      input: {
        normalizedPayloadJson: {
          mcpServers: {
            [slug]: { type: "remote", url: component.content.trim() },
          },
        },
        metadata: {
          name: component.name.trim(),
          ...(description ? { description } : {}),
        },
      },
    };
  }
  return {
    type: component.kind,
    input: {
      rawSourceText: component.kind === "skill"
        ? skillMarkdown(slug, description || component.name.trim(), component.content.trim())
        : `${component.content.trim()}\n`,
      metadata: {
        name: slug,
        ...(description ? { description } : {}),
      },
    },
  };
}

/** Same plugin bundle Den's create screen posts to `/v1/plugins`. */
export function denLibraryPluginCreateRequest(
  kind: LibraryAuthorableKind,
  input: CreateLibraryItemInput,
): DenLibraryPluginCreateRequest {
  const drafts = input.components && input.components.length > 0
    ? input.components
    : [{
      kind: kind === "plugin" ? "skill" : kind,
      name: input.name,
      description: input.description,
      content: input.instructions,
    }];
  return {
    name: input.name.trim(),
    description: input.description.trim() || null,
    orgWide: input.orgWide === true,
    marketplaceId: input.marketplaceId?.trim() || undefined,
    components: drafts.map(denLibraryPluginComponentBody),
  };
}

export type LibraryPluginFileKind = "skill" | "command" | "agent" | "mcp" | "app";

export type LibraryPluginFileRef = {
  configObjectId: string;
  objectType: string;
  title: string;
  skillName?: string;
};

export function libraryPluginFileKind(objectType: string): LibraryPluginFileKind | null {
  const kind = objectType.trim().toLowerCase();
  if (kind === "skill" || kind === "command" || kind === "agent" || kind === "mcp" || kind === "app") {
    return kind;
  }
  return null;
}

/**
 * Whether a Den plugin belongs in a category filter.
 *
 * Creating an agent, command, or skill through Add stores it in Den as a
 * plugin wrapping one component of that type. Matching only "plugin" meant an
 * item made with "Add agent" never appeared under the Agents filter — it
 * existed, but not where the user went looking for it.
 *
 * A plugin therefore also matches the filters of the components it carries.
 */
export function libraryPluginMatchesFilter(
  files: readonly LibraryPluginFileRef[],
  matches: (kind: LibraryPluginFileKind | "plugin") => boolean,
): boolean {
  if (matches("plugin")) return true;
  return files.some((file) => {
    const kind = libraryPluginFileKind(file.objectType);
    return kind !== null && matches(kind);
  });
}

export function libraryPluginFileDisplayName(file: LibraryPluginFileRef): string {
  const kind = libraryPluginFileKind(file.objectType);
  if (kind === "skill") return file.skillName ?? file.title;
  return file.title;
}

/** Prefer the same detail ids used by Library list rows so skills/commands/MCPs open their own view. */
export function libraryPluginFilePreferredDetailId(file: LibraryPluginFileRef): string | null {
  const kind = libraryPluginFileKind(file.objectType);
  const name = libraryPluginFileDisplayName(file);
  if (!kind || !name) return null;
  if (kind === "skill") return `skill:${name}`;
  if (kind === "command") return `${LIBRARY_COMMAND_DETAIL_PREFIX}cmd:${name}`;
  if (kind === "agent") return `agent:${name}`;
  if (kind === "mcp") return `connect-mcp:${name}`;
  return null;
}

export function libraryPluginFileFallbackDetailId(pluginId: string, file: LibraryPluginFileRef): string {
  return `plugin:${pluginId}/file/${file.configObjectId}`;
}

export function parseLibraryPluginFileDetailId(
  detailId: string,
): { pluginId: string; fileId: string } | null {
  const match = /^plugin:([^/]+)\/file\/(.+)$/.exec(detailId);
  if (!match) return null;
  return { pluginId: match[1], fileId: match[2] };
}

export function slugifyLibraryItemName(name: string, fallback: LibraryAuthorableKind): string {
  let base = name
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = fallback;
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!LIBRARY_ITEM_NAME_RE.test(base)) return fallback;
  return base;
}

/** Den can lag behind create; poll My Library until the new plugin is listed. */
export async function waitForListedLibraryPlugin(
  listPlugins: () => Promise<Array<{ id: string }>>,
  pluginId: string,
  options?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = options?.attempts ?? 6;
  const delayMs = options?.delayMs ?? 250;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const plugins = await listPlugins();
    if (plugins.some((plugin) => plugin.id === pluginId)) return true;
    if (attempt < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return false;
}
