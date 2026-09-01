import type { DenExternalMcpConnection } from "@/app/lib/den";
import type { McpServerEntry, McpStatus, McpStatusMap } from "@/app/types";
import { canMemberAuthorizeConnection, connectionNeedsReconnect } from "@/react-app/domains/connections/native-provider-connections";
import {
  isOrgMcpConnectionReady,
  nativeProviderDisplayName,
  orgConnectionCanRender,
} from "@/react-app/domains/settings/extension-items";

export type ComposerConnectionSignIn =
  /** Org-managed connection: the composer can start authorization itself. */
  | { kind: "org-connection"; connectionId: string; reconnect: boolean }
  /**
   * Workspace-local MCP. Its OAuth flow lives in the connections store, which
   * is created inside the settings route, so the composer cannot start it.
   * Point at Settings instead of leaving the row with a status and no action.
   */
  | { kind: "settings" };

export function orgMcpConnectionStatus(connection: DenExternalMcpConnection): McpStatus {
  if (isOrgMcpConnectionReady(connection)) return { status: "connected" };
  if (connectionNeedsReconnect(connection)) return { status: "reconnect_required" };
  if (connection.credentialMode === "shared") {
    return { status: "failed", error: "Organization setup is required." };
  }
  return { status: "needs_auth" };
}

export function orgMcpConnectionToComposerEntry(connection: DenExternalMcpConnection): McpServerEntry {
  const provider = nativeProviderDisplayName(connection.nativeProviderKey);
  return {
    id: `org-mcp:${connection.id}`,
    name: connection.name,
    config: { type: "remote", url: connection.url },
    origin: "openwork-connect",
    marketplaceName: provider ?? "OpenWork Cloud",
    orgMcpConnectionId: connection.id,
  };
}

export function mergeComposerConnectionInventory(input: {
  mcpServers: McpServerEntry[];
  mcpStatuses?: McpStatusMap;
  orgConnections: DenExternalMcpConnection[];
}): { servers: McpServerEntry[]; statuses: McpStatusMap } {
  const statuses: McpStatusMap = { ...(input.mcpStatuses ?? {}) };
  const listedConnectionIds = new Set<string>();
  const orgServers: McpServerEntry[] = [];

  for (const connection of input.orgConnections) {
    if (!orgConnectionCanRender(connection)) continue;
    const entry = orgMcpConnectionToComposerEntry(connection);
    orgServers.push(entry);
    listedConnectionIds.add(connection.id);
    const statusKey = entry.id ?? connection.id;
    statuses[statusKey] = orgMcpConnectionStatus(connection);
    statuses[connection.id] = statuses[statusKey];
  }

  const extraServers = input.mcpServers.filter((server) => {
    const connectionId = server.orgMcpConnectionId?.trim();
    if (connectionId && listedConnectionIds.has(connectionId)) return false;
    return true;
  });

  return {
    servers: [...orgServers, ...extraServers],
    statuses,
  };
}

/**
 * Whether a workspace-local MCP has an authorization flow at all. Mirrors the
 * checks in the connections store: managed OAuth, or a remote server that has
 * not opted out.
 */
function localMcpCanAuthorize(server: McpServerEntry): boolean {
  if (server.managedOAuth) return true;
  return server.config.type === "remote" && server.config.oauth !== false;
}

export function composerConnectionSignIn(input: {
  server: McpServerEntry;
  status: McpStatus | undefined;
  connection?: DenExternalMcpConnection;
}): ComposerConnectionSignIn | null {
  const status = input.status?.status;
  const reconnect = status === "reconnect_required";
  if (status !== "needs_auth" && !reconnect) return null;

  const connectionId = input.connection?.id ?? input.server.orgMcpConnectionId?.trim();
  if (connectionId) {
    if (input.connection && !canMemberAuthorizeConnection(input.connection)) return null;
    return { kind: "org-connection", connectionId, reconnect };
  }

  if (!localMcpCanAuthorize(input.server)) return null;
  return { kind: "settings" };
}
