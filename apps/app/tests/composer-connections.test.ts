import { describe, expect, test } from "bun:test";

import type { DenExternalMcpConnection } from "../src/app/lib/den";
import {
  composerConnectionSignIn,
  mergeComposerConnectionInventory,
} from "../src/react-app/domains/session/surface/composer/composer-connections";

function orgConnection(overrides: Partial<DenExternalMcpConnection> & Pick<DenExternalMcpConnection, "id" | "name">): DenExternalMcpConnection {
  return {
    url: "https://mcp.example.test",
    authType: "oauth",
    credentialMode: "per_member",
    connected: true,
    connectedAt: null,
    connectedForMe: false,
    ...overrides,
  };
}

describe("composer connection inventory", () => {
  test("lists Den org connections and drops plugin MCP duplicates of the same connection", () => {
    const merged = mergeComposerConnectionInventory({
      orgConnections: [
        orgConnection({ id: "emc_gmail", name: "Gmail", connectedForMe: false }),
      ],
      mcpServers: [
        {
          id: "openwork-connect:plugin:gmail",
          name: "Gmail plugin MCP",
          origin: "openwork-connect",
          orgMcpConnectionId: "emc_gmail",
          config: { type: "remote", url: "https://mcp.example.test" },
        },
        {
          id: "local-fs",
          name: "filesystem",
          origin: "local",
          config: { type: "local" },
        },
      ],
      mcpStatuses: {
        "openwork-connect:plugin:gmail": { status: "needs_auth" },
      },
    });

    expect(merged.servers.map((server) => server.name)).toEqual(["Gmail", "filesystem"]);
    expect(merged.statuses["org-mcp:emc_gmail"]).toEqual({ status: "needs_auth" });
  });

  test("sign-in is offered for member OAuth that still needs auth", () => {
    const connection = orgConnection({ id: "emc_gmail", name: "Gmail" });
    const server = {
      id: "org-mcp:emc_gmail",
      name: "Gmail",
      origin: "openwork-connect" as const,
      orgMcpConnectionId: "emc_gmail",
      config: { type: "remote" as const, url: connection.url },
    };
    expect(composerConnectionSignIn({
      server,
      status: { status: "needs_auth" },
      connection,
    })).toEqual({ kind: "org-connection", connectionId: "emc_gmail", reconnect: false });
  });

  test("offers a settings hop for a local MCP that needs sign-in", () => {
    // Its OAuth flow lives in the connections store, which the composer cannot
    // reach, so the row previously showed a status with nothing to click.
    expect(composerConnectionSignIn({
      server: {
        id: "local-notion",
        name: "Notion",
        config: { type: "remote" as const, url: "https://mcp.notion.com/mcp" },
      },
      status: { status: "needs_auth" },
    })).toEqual({ kind: "settings" });
  });

  test("stays quiet for a local MCP with no authorization flow", () => {
    expect(composerConnectionSignIn({
      server: {
        id: "local-fs",
        name: "Filesystem",
        config: { type: "local" as const, command: ["mcp-fs"] },
      },
      status: { status: "needs_auth" },
    })).toBe(null);

    expect(composerConnectionSignIn({
      server: {
        id: "local-optout",
        name: "No OAuth",
        config: { type: "remote" as const, url: "https://example.test/mcp", oauth: false },
      },
      status: { status: "needs_auth" },
    })).toBe(null);
  });

  test("stays quiet when nothing needs authorization", () => {
    expect(composerConnectionSignIn({
      server: {
        id: "local-notion",
        name: "Notion",
        config: { type: "remote" as const, url: "https://mcp.notion.com/mcp" },
      },
      status: { status: "connected" },
    })).toBe(null);
  });
});
