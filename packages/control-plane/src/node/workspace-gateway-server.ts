/**
 * The tools gateway's listener: `p<port>-<hash>.<domain>` requests, HTTP and
 * WebSocket, proxied to that port of the sandbox's running pod once the
 * browser shows a valid token (first as a `/__sf/<token>/` path prefix, then
 * as the host-only cookie that prefix sets).
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "../logger";
import { sandboxLabelSelector } from "../sandbox/kubernetes-manifests";
import type { KubernetesApi } from "../sandbox/kubernetes-rest-client";
import {
  WORKSPACE_GATEWAY_TOKEN_PREFIX,
  parseWorkspaceGatewayHost,
  verifyWorkspaceGatewayToken,
  type WorkspaceGatewayConfig,
} from "../sandbox/workspace-gateway";

export const WORKSPACE_GATEWAY_COOKIE = "sf_gw";

export interface WorkspaceGatewayServerOptions {
  gateway: WorkspaceGatewayConfig;
  /** The running pod's IP for a sandbox hash, or null when it has none. */
  resolvePodIp: (hash: string) => Promise<string | null>;
  log: Pick<Logger, "warn">;
  now?: () => number;
}

type Admission =
  | { kind: "proxy"; ip: string; port: number }
  | { kind: "respond"; status: number; headers?: Record<string, string>; body: string };

const DENIED_BODY = "Open this tool from the session's Tools tab in Open-Inspect.\n";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The Cookie header without the gateway's own cookie, which the tool must never see. */
function stripGatewayCookie(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${WORKSPACE_GATEWAY_COOKIE}=`));
  return kept.length ? kept.join("; ") : undefined;
}

function forwardedHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && name !== "cookie") headers[name] = value;
  }
  const cookie = stripGatewayCookie(request.headers.cookie);
  if (cookie) headers.cookie = cookie;
  return headers;
}

export function createWorkspaceGatewayServer(options: WorkspaceGatewayServerOptions): Server {
  const now = options.now ?? Date.now;

  async function admit(request: IncomingMessage): Promise<Admission> {
    const target = parseWorkspaceGatewayHost(options.gateway.domain, request.headers.host);
    if (!target) return { kind: "respond", status: 404, body: "Not found\n" };
    const url = request.url ?? "/";

    if (url.startsWith(WORKSPACE_GATEWAY_TOKEN_PREFIX)) {
      const rest = url.slice(WORKSPACE_GATEWAY_TOKEN_PREFIX.length);
      const slash = rest.search(/[/?]/);
      const token = slash === -1 ? rest : rest.slice(0, slash);
      const location =
        slash === -1 ? "/" : rest[slash] === "/" ? rest.slice(slash) : `/${rest.slice(slash)}`;
      const verified = await verifyWorkspaceGatewayToken(options.gateway.secret, token, now());
      if (!verified || verified.hash !== target.hash) {
        return { kind: "respond", status: 401, body: DENIED_BODY };
      }
      const maxAgeSeconds = Math.floor((verified.expiresAtMs - now()) / 1000);
      return {
        kind: "respond",
        status: 302,
        headers: {
          location,
          "set-cookie": `${WORKSPACE_GATEWAY_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=None; Partitioned`,
          "cache-control": "no-store",
        },
        body: "",
      };
    }

    const token = readCookie(request.headers.cookie, WORKSPACE_GATEWAY_COOKIE);
    const verified = token
      ? await verifyWorkspaceGatewayToken(options.gateway.secret, token, now())
      : null;
    if (!verified || verified.hash !== target.hash) {
      return { kind: "respond", status: 401, body: DENIED_BODY };
    }
    const ip = await options.resolvePodIp(target.hash);
    if (!ip) return { kind: "respond", status: 503, body: "The sandbox is not running.\n" };
    return { kind: "proxy", ip, port: target.port };
  }

  const server = createServer((request, response) => {
    admit(request)
      .then((admission) => {
        if (admission.kind === "respond") {
          response.writeHead(admission.status, {
            "content-type": "text/plain; charset=utf-8",
            ...admission.headers,
          });
          response.end(admission.body);
          return;
        }
        const upstream = httpRequest(
          {
            host: admission.ip,
            port: admission.port,
            method: request.method,
            path: request.url,
            headers: forwardedHeaders(request),
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          }
        );
        upstream.on("error", (error) => {
          options.log.warn("Workspace gateway upstream failed", {
            event: "workspace_gateway.upstream_failed",
            error: error.message,
          });
          if (!response.headersSent) response.writeHead(502).end("The tool did not answer.\n");
          else response.destroy();
        });
        request.pipe(upstream);
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    admit(request)
      .then((admission) => {
        if (admission.kind === "respond") {
          socket.end(`HTTP/1.1 ${admission.status} Gateway\r\nConnection: close\r\n\r\n`);
          return;
        }
        const upstream: Socket = connect(admission.port, admission.ip, () => {
          const lines = [`${request.method} ${request.url} HTTP/1.1`];
          for (const [name, value] of Object.entries(forwardedHeaders(request))) {
            for (const item of Array.isArray(value) ? value : [value])
              lines.push(`${name}: ${item}`);
          }
          upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        const close = () => {
          upstream.destroy();
          socket.destroy();
        };
        upstream.on("error", close);
        socket.on("error", close);
        upstream.on("close", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      })
      .catch(() => socket.destroy());
  });

  return server;
}

/** Pod IPs by sandbox hash, cached briefly: a resume replaces the pod and its IP. */
export function createPodIpResolver(
  api: Pick<KubernetesApi, "listPods">,
  cacheMs = 5_000,
  now: () => number = Date.now
): (hash: string) => Promise<string | null> {
  const cache = new Map<string, { ip: string | null; atMs: number }>();
  return async (hash) => {
    const cached = cache.get(hash);
    if (cached && now() - cached.atMs < cacheMs) return cached.ip;
    const pods = await api.listPods(sandboxLabelSelector({ hash, base: `oi-${hash}` }));
    const running = pods.find(
      (pod) =>
        pod.status?.phase === "Running" && pod.status.podIP && !pod.metadata.deletionTimestamp
    );
    const ip = running?.status?.podIP ?? null;
    cache.set(hash, { ip, atMs: now() });
    return ip;
  };
}
