import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubBotNodeRuntime, type GitHubBotNodeRuntime } from "../src/node/runtime";
import { nodeConfig, reviewSubmittedPayload, webhookRequest } from "./node-support";

/** A control plane that accepts every request and records what reached it. */
function recordingControlPlane() {
  const requests: Array<{ url: string; service: string | null; body: string }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      service: request.headers.get("X-OpenInspect-Service"),
      body: await request.text(),
    });
    return new Response(null, { status: 202 });
  });
  return { requests, fetchFn: fetchFn as unknown as typeof fetch };
}

describe("GitHub bot Node entry", () => {
  let stateDir: string;
  const runtimes: GitHubBotNodeRuntime[] = [];

  const start = (
    fetchFn: typeof fetch,
    vars: Parameters<typeof nodeConfig>[1] = {}
  ): GitHubBotNodeRuntime => {
    const runtime = createGitHubBotNodeRuntime(nodeConfig(stateDir, vars), { fetchFn });
    runtimes.push(runtime);
    return runtime;
  };

  /** Drain and close, as SIGTERM does. */
  const stop = async (runtime: GitHubBotNodeRuntime): Promise<void> => {
    expect(await runtime.tasks.drain(5_000)).toBe(0);
    runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "github-bot-node-"));
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.tasks.drain(5_000);
      runtime.close();
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("answers GET /health", async () => {
    const runtime = start(recordingControlPlane().fetchFn);

    const response = await runtime.fetch(new Request("http://github-bot.test/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "healthy",
      service: "open-inspect-github-bot",
    });
  });

  it("rejects a delivery with a bad signature with 401 and reaches nothing", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const runtime = start(fetchFn);

    const response = await runtime.fetch(
      await webhookRequest("pull_request_review", "delivery-1", reviewSubmittedPayload(), "wrong")
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid signature" });
    await stop(runtime);
    expect(requests).toEqual([]);
  });

  it("posts an Autofix envelope to the control plane's job ingress, signed as github-bot", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const runtime = start(fetchFn);

    const response = await runtime.fetch(
      await webhookRequest("pull_request_review", "delivery-2", reviewSubmittedPayload())
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await stop(runtime);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://control-plane.test/internal/jobs/github.autofix");
    expect(requests[0].service).toBe("github-bot");
    expect(JSON.parse(requests[0].body)).toEqual({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      deliveryId: "delivery-2",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: expect.any(String),
    });
  });

  it("skips a delivery id replayed after a process restart", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const first = start(fetchFn);
    const delivery = () =>
      webhookRequest("pull_request_review", "delivery-3", reviewSubmittedPayload());

    expect(await (await first.fetch(await delivery())).json()).toEqual({ ok: true });
    await stop(first);

    const second = start(fetchFn);
    const replay = await second.fetch(await delivery());

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    await stop(second);
    expect(requests).toHaveLength(1);
  });

  it("acknowledges and ignores a delivery for a repository outside the allowlist", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const runtime = start(fetchFn);
    const otherRepo = { id: 100, name: "other", private: true, owner: { login: "acme" } };

    const response = await runtime.fetch(
      await webhookRequest("pull_request_review", "delivery-4", reviewSubmittedPayload(otherRepo))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: "repo_not_allowlisted" });
    await stop(runtime);
    expect(requests).toEqual([]);
  });

  it("matches the allowlist case-insensitively", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const runtime = start(fetchFn, { SF_GITHUB_REPO_ALLOWLIST: " Acme/Widgets ,acme/other" });

    const response = await runtime.fetch(
      await webhookRequest("pull_request_review", "delivery-5", reviewSubmittedPayload())
    );

    expect(await response.json()).toEqual({ ok: true });
    await stop(runtime);
    expect(requests.map((request) => request.url)).toEqual([
      "http://control-plane.test/internal/jobs/github.autofix",
    ]);
  });

  it("ignores every repository when the allowlist is empty", async () => {
    const { requests, fetchFn } = recordingControlPlane();
    const runtime = start(fetchFn, { SF_GITHUB_REPO_ALLOWLIST: "" });

    const response = await runtime.fetch(
      await webhookRequest("pull_request_review", "delivery-6", reviewSubmittedPayload())
    );

    expect(await response.json()).toEqual({ ok: true, ignored: "repo_not_allowlisted" });
    await stop(runtime);
    expect(requests).toEqual([]);
  });

  it("sweeps expired delivery entries from the cache file", async () => {
    const runtime = start(recordingControlPlane().fetchFn);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      expect(
        await (
          await runtime.fetch(
            await webhookRequest("pull_request_review", "delivery-7", reviewSubmittedPayload())
          )
        ).json()
      ).toEqual({ ok: true });
      await runtime.tasks.drain(5_000);

      // Past the processed-delivery TTL: the sweep drops the entry, so the
      // same delivery id is no longer a duplicate.
      vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1_000 + 1);
      await runtime.sweepCache();
      vi.setSystemTime(now);
      const again = await runtime.fetch(
        await webhookRequest("pull_request_review", "delivery-7", reviewSubmittedPayload())
      );
      expect(await again.json()).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
