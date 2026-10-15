/**
 * Workspace tools gateway: browser access to a Kubernetes sandbox's code-server,
 * terminal, desktop and tunnel ports through `p<port>-<hash>.<domain>`, where
 * `hash` is the sandbox's object hash (its pod label). Links carry a signed
 * token in a `/__sf/<token>/` path prefix that the gateway trades for a cookie.
 */

import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared/auth";

/** How long a link minted for an authorized viewer, and the cookie it becomes, stay valid. */
export const WORKSPACE_GATEWAY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Path prefix that carries the token on the first request to a tool host. */
export const WORKSPACE_GATEWAY_TOKEN_PREFIX = "/__sf/";

export interface WorkspaceGatewayConfig {
  /** Parent domain of the tool hosts, e.g. `sbx.example.com`. */
  domain: string;
  /** Port browsers use when it is not 443 (the TLS front end's, not the gateway's). */
  publicPort?: number;
  secret: string;
}

/** The browser URL of a tool: its host, the public port when there is one, and `/`. */
export function workspaceGatewayUrl(
  gateway: Pick<WorkspaceGatewayConfig, "domain" | "publicPort">,
  port: number,
  hash: string
): string {
  const suffix = gateway.publicPort ? `:${gateway.publicPort}` : "";
  return `https://${workspaceGatewayHost(gateway.domain, port, hash)}${suffix}/`;
}

const HASH_PATTERN = /^[0-9a-f]{20}$/;
const HOST_LABEL_PATTERN = /^p(\d{1,5})-([0-9a-f]{20})$/;

export function workspaceGatewayHost(domain: string, port: number, hash: string): string {
  return `p${port}-${hash}.${domain}`;
}

/** The sandbox port and hash a request's Host names, or null when it is not a tool host. */
export function parseWorkspaceGatewayHost(
  domain: string,
  host: string | undefined
): { port: number; hash: string } | null {
  if (!host) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return null;
  const match = HOST_LABEL_PATTERN.exec(hostname.slice(0, -suffix.length));
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  return { port, hash: match[2]! };
}

function tokenPayload(hash: string, expiresAtMs: number): string {
  return `workspace-gateway:${hash}:${expiresAtMs}`;
}

export async function signWorkspaceGatewayToken(
  secret: string,
  hash: string,
  nowMs: number
): Promise<string> {
  const expiresAtMs = nowMs + WORKSPACE_GATEWAY_TOKEN_TTL_MS;
  const signature = await computeHmacHex(tokenPayload(hash, expiresAtMs), secret);
  return `${hash}.${expiresAtMs.toString(36)}.${signature}`;
}

/** The sandbox hash and expiry of a valid, unexpired token; null otherwise. */
export async function verifyWorkspaceGatewayToken(
  secret: string,
  token: string,
  nowMs: number
): Promise<{ hash: string; expiresAtMs: number } | null> {
  const [hash, expiry, signature, ...rest] = token.split(".");
  if (rest.length || !hash || !expiry || !signature || !HASH_PATTERN.test(hash)) return null;
  const expiresAtMs = Number.parseInt(expiry, 36);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return null;
  const expected = await computeHmacHex(tokenPayload(hash, expiresAtMs), secret);
  return timingSafeEqual(signature, expected) ? { hash, expiresAtMs } : null;
}

/** A tool URL as an authorized viewer opens it: the token rides in the path prefix. */
export function withWorkspaceGatewayToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${WORKSPACE_GATEWAY_TOKEN_PREFIX}${token}${parsed.pathname}`;
  return parsed.toString();
}

/** The sandbox hash of a gateway tool URL under `domain`, or null for any other URL. */
export function workspaceGatewayUrlHash(domain: string, url: string): string | null {
  try {
    return parseWorkspaceGatewayHost(domain, new URL(url).host)?.hash ?? null;
  } catch {
    return null;
  }
}
