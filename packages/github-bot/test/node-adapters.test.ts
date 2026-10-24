import { describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { BackgroundTasks } from "../src/node/background-tasks";
import {
  createControlPlaneAutofixQueue,
  createControlPlaneFetcher,
} from "../src/node/control-plane";
import { createLogger } from "../src/logger";

const ENVELOPE = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-10-24T08:00:00.000Z",
} as const;

describe("createControlPlaneFetcher", () => {
  it("sends the internal URL's path and query to the control-plane origin", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    const fetcher = createControlPlaneFetcher(
      "http://control-plane:8787",
      fetchFn as unknown as typeof fetch
    );

    await fetcher.fetch("https://internal/github/route?repositoryId=99", {
      method: "GET",
      headers: { "X-Test": "1" },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [target, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe("http://control-plane:8787/github/route?repositoryId=99");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "X-Test": "1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createControlPlaneAutofixQueue", () => {
  it("posts the envelope to the job ingress with a github-bot signature the control plane accepts", async () => {
    const seen: Request[] = [];
    const fetchFn = vi.fn(async (input: URL, init: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(null, { status: 202 });
    });
    const queue = createControlPlaneAutofixQueue({
      CONTROL_PLANE: createControlPlaneFetcher(
        "http://control-plane:8787",
        fetchFn as unknown as typeof fetch
      ),
      SERVICE_AUTH_SECRET: "secret-1",
    });

    await queue.send(ENVELOPE);

    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://control-plane:8787/internal/jobs/github.autofix");
    const body = await request.text();
    expect(JSON.parse(body)).toEqual(ENVELOPE);
    expect(request.headers.get("X-OpenInspect-Service")).toBe("github-bot");
    const verified = await verifyServiceSignature({
      signatureHeader: request.headers.get("X-OpenInspect-Service-Signature") ?? "",
      service: "github-bot",
      secret: "secret-1",
      method: "POST",
      url: request.url,
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verified.ok).toBe(true);
  });

  it("rejects when the control plane does not store the job", async () => {
    const queue = createControlPlaneAutofixQueue({
      CONTROL_PLANE: { fetch: async () => new Response("nope", { status: 503 }) },
      SERVICE_AUTH_SECRET: "secret-1",
    });

    await expect(queue.send(ENVELOPE)).rejects.toThrow("Autofix job ingress failed: 503");
  });
});

describe("BackgroundTasks", () => {
  const log = createLogger("test", {}, "error");

  it("drains tracked work, including work started while draining", async () => {
    const tasks = new BackgroundTasks(log);
    const order: string[] = [];
    tasks.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push("first");
          tasks.track(Promise.resolve().then(() => order.push("second")));
          resolve();
        }, 5)
      )
    );
    tasks.track(Promise.reject(new Error("logged, not thrown")));

    expect(await tasks.drain(1_000)).toBe(0);
    expect(order).toEqual(["first", "second"]);
    expect(tasks.size).toBe(0);
  });

  it("reports the work still running at the deadline", async () => {
    const tasks = new BackgroundTasks(log);
    tasks.track(new Promise(() => {}));

    expect(await tasks.drain(10)).toBe(1);
  });
});
