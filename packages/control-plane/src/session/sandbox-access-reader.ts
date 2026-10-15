import type { Logger } from "../logger";
import { isSandboxAccessAvailable } from "../sandbox/lifecycle/decisions";
import { decryptStoredAccessValue } from "./sandbox-access";
import type { SandboxStateReader } from "./sandbox-ports";
import type { SessionCoreRepository } from "./session-core-repository";
import { resolveSandboxDashboardUrl, type SandboxDashboardSettings } from "./sandbox-access";
import { safeParseTunnelUrls } from "./tunnel-urls";
import {
  signWorkspaceGatewayToken,
  withWorkspaceGatewayToken,
  workspaceGatewayUrlHash,
  type WorkspaceGatewayConfig,
} from "../sandbox/workspace-gateway";

export interface SessionAccessReaderDeps {
  sessionCoreRepository: Pick<SessionCoreRepository, "getSession">;
  sandboxRepository: SandboxStateReader;
  repoSecretsEncryptionKey: string;
  sandboxDashboardSettings: SandboxDashboardSettings;
  log: Logger;
  /** Tool links on the gateway's domain are handed out with a token for this viewer. */
  workspaceGateway?: WorkspaceGatewayConfig;
  now?: () => number;
}

/**
 * Serves the sandbox access credentials (code-server, VNC, ttyd) for a ready
 * sandbox, decrypting stored secrets and re-checking the row after the async
 * decrypts so a mid-flight replacement cannot leak mismatched credentials.
 */
export class SessionAccessReader {
  constructor(private readonly deps: SessionAccessReaderDeps) {}

  async handleSandboxAccess(): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    if (!this.deps.sessionCoreRepository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404, headers });
    }
    const sandbox = this.deps.sandboxRepository.getSandbox();
    if (!sandbox || !isSandboxAccessAvailable(sandbox.status)) {
      return Response.json({ error: "Sandbox access is unavailable" }, { status: 409, headers });
    }

    const encryptionKey = this.deps.repoSecretsEncryptionKey;
    const [codeServerPassword, vncPassword, ttydToken] = await Promise.all([
      decryptStoredAccessValue(sandbox.code_server_password, encryptionKey, this.deps.log),
      decryptStoredAccessValue(sandbox.vnc_password, encryptionKey, this.deps.log),
      decryptStoredAccessValue(sandbox.ttyd_token, encryptionKey, this.deps.log),
    ]);
    const current = this.deps.sandboxRepository.getSandbox();
    if (
      !current ||
      current.id !== sandbox.id ||
      !isSandboxAccessAvailable(current.status) ||
      current.code_server_url !== sandbox.code_server_url ||
      current.code_server_password !== sandbox.code_server_password ||
      current.vnc_url !== sandbox.vnc_url ||
      current.vnc_password !== sandbox.vnc_password ||
      current.ttyd_url !== sandbox.ttyd_url ||
      current.ttyd_token !== sandbox.ttyd_token ||
      current.tunnel_urls !== sandbox.tunnel_urls ||
      current.modal_object_id !== sandbox.modal_object_id
    ) {
      return Response.json({ error: "Sandbox access changed; retry" }, { status: 409, headers });
    }
    const link = await this.gatewayLinker();
    const tunnelUrls = current.tunnel_urls
      ? safeParseTunnelUrls(current.tunnel_urls, this.deps.log)
      : null;
    return Response.json(
      {
        codeServer:
          current.code_server_url && codeServerPassword
            ? { url: await link(current.code_server_url), password: codeServerPassword }
            : null,
        vnc:
          current.vnc_url && vncPassword
            ? { url: await link(current.vnc_url), password: vncPassword }
            : null,
        ttyd:
          current.ttyd_url && ttydToken
            ? { url: await link(current.ttyd_url), token: ttydToken }
            : null,
        tunnelUrls: tunnelUrls
          ? Object.fromEntries(
              await Promise.all(
                Object.entries(tunnelUrls).map(async ([port, url]) => [port, await link(url)])
              )
            )
          : null,
        sandboxDashboardUrl: resolveSandboxDashboardUrl(
          this.deps.sandboxDashboardSettings,
          current.modal_object_id
        ),
      },
      { headers }
    );
  }

  /** Adds a fresh token to links on the gateway's domain; other links pass through. */
  private async gatewayLinker(): Promise<(url: string) => Promise<string>> {
    const gateway = this.deps.workspaceGateway;
    if (!gateway) return async (url) => url;
    const nowMs = (this.deps.now ?? Date.now)();
    const tokens = new Map<string, Promise<string>>();
    return async (url) => {
      const hash = workspaceGatewayUrlHash(gateway.domain, url);
      if (!hash) return url;
      if (!tokens.has(hash))
        tokens.set(hash, signWorkspaceGatewayToken(gateway.secret, hash, nowMs));
      return withWorkspaceGatewayToken(url, await tokens.get(hash)!);
    };
  }
}
