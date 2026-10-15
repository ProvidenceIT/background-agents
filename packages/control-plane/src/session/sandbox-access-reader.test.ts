import { describe, expect, it, vi } from "vitest";
import { encryptToken, generateEncryptionKey } from "../auth/crypto";
import { verifyWorkspaceGatewayToken } from "../sandbox/workspace-gateway";
import { SessionAccessReader } from "./sandbox-access-reader";
import type { SandboxRow } from "./types";

const HASH = "0123456789abcdef0123";
const KEY = await generateEncryptionKey();

async function read(row: Partial<SandboxRow>) {
  const sandbox = {
    id: "sb",
    status: "ready",
    code_server_url: null,
    code_server_password: null,
    vnc_url: null,
    vnc_password: null,
    ttyd_url: null,
    ttyd_token: null,
    tunnel_urls: null,
    modal_object_id: `oi-${HASH}`,
    ...row,
  } as SandboxRow;
  const reader = new SessionAccessReader({
    sessionCoreRepository: { getSession: () => ({}) as never },
    sandboxRepository: { getSandbox: () => sandbox } as never,
    repoSecretsEncryptionKey: KEY,
    sandboxDashboardSettings: { sandboxProvider: "kubernetes" },
    log: { warn: vi.fn() } as never,
    workspaceGateway: { domain: "sbx.test", secret: "gateway-secret" },
    now: () => 1_000,
  });
  return (await (await reader.handleSandboxAccess()).json()) as {
    ttyd: { url: string; token: string } | null;
    tunnelUrls: Record<string, string> | null;
  };
}

describe("SessionAccessReader with the tools gateway", () => {
  it("hands out gateway links with a token for that sandbox and leaves other links alone", async () => {
    const body = await read({
      ttyd_url: `https://term-${HASH}.sbx.test/`,
      ttyd_token: await encryptToken("jwt", KEY),
      tunnel_urls: JSON.stringify({
        "3000": `https://p3000-${HASH}.sbx.test/`,
        "4000": "https://elsewhere.example/",
      }),
    });

    const match = /^https:\/\/term-0123456789abcdef0123\.sbx\.test\/__sf\/([^/]+)\/$/.exec(
      body.ttyd!.url
    );
    expect(body.ttyd!.token).toBe("jwt");
    expect(await verifyWorkspaceGatewayToken("gateway-secret", match![1]!, 2_000)).toMatchObject({
      hash: HASH,
    });
    expect(body.tunnelUrls).toEqual({
      "3000": `https://p3000-${HASH}.sbx.test/__sf/${match![1]}/`,
      "4000": "https://elsewhere.example/",
    });
  });
});
