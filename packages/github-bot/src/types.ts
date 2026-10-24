/**
 * Environment bindings for the GitHub bot: Cloudflare bindings on the
 * Worker, Node adapters of the same shapes on the Node entry (src/node/).
 */
import type { CacheStore } from "@open-inspect/shared/cache-store";
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";

/** Where Autofix envelopes go; resolves once the envelope is durable. */
export interface AutofixQueue {
  send(envelope: GitHubAutofixEnvelope): Promise<void>;
}

export interface Env {
  /** Webhook delivery dedupe: a KV namespace on the Worker, a SQLite cache file on Node. */
  GITHUB_KV: CacheStore;

  /**
   * Durable handoff for pull request feedback that may trigger Autofix: a
   * Cloudflare Queue on the Worker, the control plane's job ingress on Node.
   */
  AUTOFIX_QUEUE: AutofixQueue;

  /** The control plane: a service binding on the Worker, a URL-bound fetcher on Node. */
  CONTROL_PLANE: ControlPlaneFetcher;

  /** Repositories to act on (see repo-allowlist.ts); unset acts on every repository. */
  SF_GITHUB_REPO_ALLOWLIST?: string;

  /** Deployment name for logging/identification. */
  DEPLOYMENT_NAME: string;

  /** Display name shown in user-visible bot messages and HTTP User-Agent headers. */
  APP_NAME?: string;

  /** Default model ID for new sessions. */
  DEFAULT_MODEL: string;

  /** GitHub App bot username (e.g., "open-inspect-bot[bot]"). */
  GITHUB_BOT_USERNAME: string;

  /** GitHub App ID for JWT generation. */
  GITHUB_APP_ID: string;

  /** GitHub App private key (PKCS#8 PEM) for JWT signing. */
  GITHUB_APP_PRIVATE_KEY: string;

  /** GitHub App installation ID for token exchange. */
  GITHUB_APP_INSTALLATION_ID: string;

  /** Webhook secret for verifying GitHub webhook signatures. */
  GITHUB_WEBHOOK_SECRET: string;

  /** Per-service sig1 signing secret. */
  SERVICE_AUTH_SECRET?: string;

  /** Optional log level override. */
  LOG_LEVEL?: string;
}

export type {
  IssueCommentPayload,
  PullRequestOpenedPayload,
  ReviewCommentPayload,
  ReviewRequestedPayload,
} from "./payload-schemas";
