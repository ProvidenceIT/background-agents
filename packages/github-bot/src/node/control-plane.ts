/**
 * The Node adapters for the two bindings that reach the control plane: the
 * `CONTROL_PLANE` service binding becomes a fetcher bound to
 * `CONTROL_PLANE_URL`, and the `AUTOFIX_QUEUE` Queue becomes a signed post to
 * the control plane's job ingress, which enqueues the same `github.autofix`
 * job the Queue would have delivered.
 */

import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import {
  signedControlPlaneFetch,
  type ControlPlaneFetcher,
  type OutboundCredentialEnv,
} from "@open-inspect/shared/service-auth";
import type { AutofixQueue } from "../types";

/** How long one control-plane request may take before it is abandoned. */
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;

/** The control plane's ingress for `github.autofix` jobs. */
const AUTOFIX_JOB_INGRESS_URL = "https://internal/internal/jobs/github.autofix";

/**
 * A fetcher that sends the bot's `https://internal/...` requests to
 * `baseUrl` instead. Only the origin changes: sig1 signs the path and query,
 * which is why `baseUrl` is an origin (config.ts holds it to that).
 */
export function createControlPlaneFetcher(
  baseUrl: string,
  fetchFn: typeof fetch = fetch
): ControlPlaneFetcher {
  const origin = new URL(baseUrl);
  return {
    fetch(input, init) {
      const source = new URL(input instanceof Request ? input.url : input);
      const target = new URL(`${source.pathname}${source.search}`, origin);
      const timeout = AbortSignal.timeout(CONTROL_PLANE_REQUEST_TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const request = input instanceof Request ? new Request(target, input) : target;
      return fetchFn(request, { ...init, signal });
    },
  };
}

/** `AUTOFIX_QUEUE` on Node: resolves once the control plane has stored the job. */
export function createControlPlaneAutofixQueue(
  env: OutboundCredentialEnv & { CONTROL_PLANE: ControlPlaneFetcher }
): AutofixQueue {
  return {
    async send(envelope: GitHubAutofixEnvelope): Promise<void> {
      const response = await signedControlPlaneFetch("github-bot", env, {
        method: "POST",
        url: AUTOFIX_JOB_INGRESS_URL,
        body: JSON.stringify(envelope),
        traceId: envelope.deliveryId,
      });
      if (!response.ok) {
        throw new Error(`Autofix job ingress failed: ${response.status}`);
      }
    },
  };
}
