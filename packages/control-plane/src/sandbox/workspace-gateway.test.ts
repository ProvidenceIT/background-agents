import { describe, expect, it } from "vitest";
import {
  WORKSPACE_GATEWAY_TOKEN_TTL_MS,
  parseWorkspaceGatewayHost,
  signWorkspaceGatewayToken,
  verifyWorkspaceGatewayToken,
  withWorkspaceGatewayToken,
  workspaceGatewayHost,
  workspaceGatewayUrlHash,
} from "./workspace-gateway";

const HASH = "0123456789abcdef0123";
const DOMAIN = "sbx.example.com";

describe("workspace gateway hosts", () => {
  it("names and parses each tool host", () => {
    expect(workspaceGatewayHost(DOMAIN, 3000, HASH)).toBe(`p3000-${HASH}.sbx.example.com`);
    expect(parseWorkspaceGatewayHost(DOMAIN, `P8080-${HASH}.sbx.example.com:443`)).toEqual({
      port: 8080,
      hash: HASH,
    });
  });

  it("rejects hosts outside the domain, unknown tools and impossible ports", () => {
    expect(parseWorkspaceGatewayHost(DOMAIN, `p80-${HASH}.evil.com`)).toBeNull();
    expect(parseWorkspaceGatewayHost(DOMAIN, `p80-${HASH}.xsbx.example.com`)).toBeNull();
    expect(parseWorkspaceGatewayHost(DOMAIN, `code-${HASH}.sbx.example.com`)).toBeNull();
    expect(parseWorkspaceGatewayHost(DOMAIN, `p70000-${HASH}.sbx.example.com`)).toBeNull();
    expect(parseWorkspaceGatewayHost(DOMAIN, `p80-${HASH}.sbx.example.com`)).not.toBeNull();
  });
});

describe("workspace gateway tokens", () => {
  it("verifies a fresh token for its sandbox until it expires", async () => {
    const token = await signWorkspaceGatewayToken("secret", HASH, 1_000);
    expect(await verifyWorkspaceGatewayToken("secret", token, 2_000)).toEqual({
      hash: HASH,
      expiresAtMs: 1_000 + WORKSPACE_GATEWAY_TOKEN_TTL_MS,
    });
    expect(
      await verifyWorkspaceGatewayToken("secret", token, 1_000 + WORKSPACE_GATEWAY_TOKEN_TTL_MS)
    ).toBeNull();
  });

  it("rejects another secret, a swapped hash and a stretched expiry", async () => {
    const token = await signWorkspaceGatewayToken("secret", HASH, 1_000);
    const [, expiry, signature] = token.split(".");
    expect(await verifyWorkspaceGatewayToken("other", token, 2_000)).toBeNull();
    expect(
      await verifyWorkspaceGatewayToken(
        "secret",
        `ffffffffffffffffffff.${expiry}.${signature}`,
        2_000
      )
    ).toBeNull();
    expect(
      await verifyWorkspaceGatewayToken("secret", `${HASH}.zzzzzzzzz.${signature}`, 2_000)
    ).toBeNull();
    expect(await verifyWorkspaceGatewayToken("secret", token, 2_000)).not.toBeNull();
  });

  it("puts the token in the path prefix and reads a URL's sandbox", () => {
    const url = `https://p6080-${HASH}.sbx.example.com/`;
    expect(withWorkspaceGatewayToken(url, "t0k")).toBe(
      `https://p6080-${HASH}.sbx.example.com/__sf/t0k/`
    );
    expect(workspaceGatewayUrlHash(DOMAIN, url)).toBe(HASH);
    expect(workspaceGatewayUrlHash(DOMAIN, "https://modal.run/x")).toBeNull();
  });
});
