import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { signWorkspaceGatewayToken } from "../sandbox/workspace-gateway";
import { createPodIpResolver, createWorkspaceGatewayServer } from "./workspace-gateway-server";

const HASH = "0123456789abcdef0123";
const SECRET = "gateway-secret";
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A stand-in sandbox tool that echoes what it received, with a WebSocket echo beside it. */
async function startTool(): Promise<number> {
  const tool = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
  });
  const wss = new WebSocketServer({ server: tool });
  wss.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo:${data}`)));
  return listen(tool);
}

async function startGateway(podIp: string | null): Promise<number> {
  return listen(
    createWorkspaceGatewayServer({
      gateway: { domain: "sbx.test", secret: SECRET },
      resolvePodIp: async (hash) => (hash === HASH ? podIp : null),
      log: { warn: () => {} },
    })
  );
}

function get(
  gatewayPort: number,
  host: string,
  path: string,
  cookie?: string
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path,
        headers: { host, ...(cookie ? { cookie } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("workspace gateway server", () => {
  it("trades a link's token for a cookie and then proxies to the pod's port", async () => {
    const toolPort = await startTool();
    const gatewayPort = await startGateway("127.0.0.1");
    const host = `p${toolPort}-${HASH}.sbx.test`;
    const token = await signWorkspaceGatewayToken(SECRET, HASH, Date.now());

    const first = await get(gatewayPort, host, `/__sf/${token}/vnc.html?autoconnect=true`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/vnc.html?autoconnect=true");
    expect(first.headers["set-cookie"]![0]).toMatch(
      new RegExp(
        `^sf_gw=${token.replace(/\./g, "\\.")}; Path=/; Max-Age=\\d+; Secure; HttpOnly; SameSite=None; Partitioned$`
      )
    );

    const proxied = await get(gatewayPort, host, "/vnc.html?x=1", `theme=dark; sf_gw=${token}`);
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body)).toEqual({ path: "/vnc.html?x=1", cookie: "theme=dark" });
  });

  it("refuses requests without a valid token for that sandbox", async () => {
    const gatewayPort = await startGateway("127.0.0.1");
    const host = `p8080-${HASH}.sbx.test`;
    const otherToken = await signWorkspaceGatewayToken(SECRET, "ffffffffffffffffffff", Date.now());
    expect((await get(gatewayPort, host, "/")).status).toBe(401);
    expect((await get(gatewayPort, host, `/__sf/${otherToken}/`)).status).toBe(401);
    expect((await get(gatewayPort, host, "/", `sf_gw=${otherToken}`)).status).toBe(401);
    expect((await get(gatewayPort, "evil.example", "/")).status).toBe(404);
  });

  it("answers 503 when the sandbox has no running pod", async () => {
    const gatewayPort = await startGateway(null);
    const token = await signWorkspaceGatewayToken(SECRET, HASH, Date.now());
    const res = await get(gatewayPort, `p8080-${HASH}.sbx.test`, "/", `sf_gw=${token}`);
    expect(res.status).toBe(503);
  });

  it("proxies a WebSocket once the cookie is present", async () => {
    const toolPort = await startTool();
    const gatewayPort = await startGateway("127.0.0.1");
    const token = await signWorkspaceGatewayToken(SECRET, HASH, Date.now());
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, {
      headers: { host: `p${toolPort}-${HASH}.sbx.test`, cookie: `sf_gw=${token}` },
    });
    await once(socket, "open");
    socket.send("hi");
    const [reply] = await once(socket, "message");
    expect(String(reply)).toBe("echo:hi");
    socket.close();

    const denied = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, {
      headers: { host: `p${toolPort}-${HASH}.sbx.test` },
    });
    const [error] = await once(denied, "error");
    expect(String(error)).toContain("401");
  });
});

describe("createPodIpResolver", () => {
  it("picks the running pod that is not terminating, and caches briefly", async () => {
    let nowMs = 0;
    const listPods = vi.fn(async (selector: string) => {
      expect(selector).toBe(
        `app.kubernetes.io/managed-by=open-inspect,openinspect.dev/sandbox=${HASH}`
      );
      return [
        {
          metadata: { name: "old", deletionTimestamp: "x" },
          status: { phase: "Running", podIP: "10.0.0.1" },
        },
        { metadata: { name: "new" }, status: { phase: "Running", podIP: "10.0.0.2" } },
      ];
    });
    const resolve = createPodIpResolver({ listPods }, 5_000, () => nowMs);
    expect(await resolve(HASH)).toBe("10.0.0.2");
    nowMs = 4_000;
    expect(await resolve(HASH)).toBe("10.0.0.2");
    expect(listPods).toHaveBeenCalledTimes(1);
    nowMs = 6_000;
    await resolve(HASH);
    expect(listPods).toHaveBeenCalledTimes(2);
  });
});
