import { describe, expect, it } from "vitest";
import {
  createMotionTaskClient,
  delegatedWorkIdFromRef,
  parseMotionApiUrl,
  toMotionTaskView,
} from "./motion-client";

type Call = { url: string; init: RequestInit };

function fakeMotion(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const route = routes[key];
    return route ? route() : Response.json({ success: false }, { status: 404 });
  };
  return {
    calls,
    client: createMotionTaskClient({ baseUrl: "https://motion.test", apiKey: "mk_key", fetch }),
  };
}

const ok =
  (data: unknown, status = 200) =>
  () =>
    Response.json({ success: true, data }, { status });

const TASK = {
  id: "task_1",
  title: "Fix the invoice export",
  description: "CSV totals are off by one cent.",
  status: "IN_PROGRESS",
  priority: "HIGH",
  dueDate: "2026-10-30T00:00:00.000Z",
  project: { id: "p1", name: "Billing", workspaceId: "w1" },
  assignee: { id: "u1", name: "Sam", email: "sam@client.example" },
  labels: [{ label: { id: "l1", name: "bug" } }],
  subtasks: [{ title: "Add a test", completed: true }],
};

describe("motion task client", () => {
  it("resolves the Task from the delegated work, with the key as a bearer token", async () => {
    const { calls, client } = fakeMotion({
      "GET /api/v1/open-inspect/delegated-work/dw_1": ok({ taskId: "task_1" }),
      "GET /api/v1/tasks/task_1": ok(TASK),
    });
    expect(await client.getTask("dw_1")).toEqual({
      ok: true,
      value: {
        id: "task_1",
        title: "Fix the invoice export",
        description: "CSV totals are off by one cent.",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueDate: "2026-10-30T00:00:00.000Z",
        project: "Billing",
        labels: ["bug"],
        subtasks: [{ title: "Add a test", completed: true }],
      },
    });
    expect(calls.map((call) => new Headers(call.init.headers).get("Authorization"))).toEqual([
      "Bearer mk_key",
      "Bearer mk_key",
    ]);
    expect(JSON.stringify(await client.getTask("dw_1"))).not.toContain("sam@client.example");
  });

  it("posts the note on the resolved Task and never touches its status", async () => {
    const { calls, client } = fakeMotion({
      "GET /api/v1/open-inspect/delegated-work/dw_1": ok({ taskId: "task_1" }),
      "POST /api/v1/notes": ok({ id: "note_1" }, 201),
    });
    expect(await client.addNote("dw_1", { title: "Findings", content: "Body" })).toEqual({
      ok: true,
      value: { noteId: "note_1" },
    });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      title: "Findings",
      content: "Body",
      taskId: "task_1",
    });
    expect(calls.every((call) => call.init.method !== "PATCH")).toBe(true);
  });

  it("reports delegated work without a Task, a refused key and an outage as codes", async () => {
    const unlinked = fakeMotion({
      "GET /api/v1/open-inspect/delegated-work/dw_1": ok({ taskId: null }),
    });
    expect(await unlinked.client.getTask("dw_1")).toEqual({ ok: false, reason: "not_linked" });
    expect(await fakeMotion({}).client.getTask("dw_1")).toEqual({
      ok: false,
      reason: "not_linked",
    });
    const refused = fakeMotion({
      "GET /api/v1/open-inspect/delegated-work/dw_1": () => new Response("{}", { status: 403 }),
    });
    expect(await refused.client.getTask("dw_1")).toEqual({ ok: false, reason: "unauthorized" });
    const down = createMotionTaskClient({
      baseUrl: "https://motion.test",
      apiKey: "k",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1");
      },
    });
    expect(await down.getTask("dw_1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("cannot say whether a note was added once its POST went out and failed", async () => {
    const lookup = { "GET /api/v1/open-inspect/delegated-work/dw_1": ok({ taskId: "task_1" }) };
    const note = { title: "Findings", content: "Body" };
    for (const answer of [
      () => new Response("{}", { status: 502 }),
      () => new Response("not json", { status: 201 }),
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ]) {
      const { client } = fakeMotion({ ...lookup, "POST /api/v1/notes": answer });
      expect(await client.addNote("dw_1", note)).toEqual({ ok: false, reason: "outcome_unknown" });
    }
    // A refusal is definite: nothing was added.
    const limited = fakeMotion({
      ...lookup,
      "POST /api/v1/notes": () => new Response("{}", { status: 429 }),
    });
    expect(await limited.client.addNote("dw_1", note)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    // The lookup before the POST is safe to repeat.
    const down = fakeMotion({
      "GET /api/v1/open-inspect/delegated-work/dw_1": () => new Response("{}", { status: 503 }),
    });
    expect(await down.client.addNote("dw_1", note)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("motion refs and configuration", () => {
  it("accepts only motion's delegated-work refs", () => {
    expect(delegatedWorkIdFromRef("providence/delegated-work/dw_1")).toBe("dw_1");
    expect(delegatedWorkIdFromRef("providence/delegated-work/a/b")).toBeNull();
    expect(delegatedWorkIdFromRef("linear/issue/1")).toBeNull();
  });

  it("requires an https base URL without a query", () => {
    expect(parseMotionApiUrl("https://motion.example/")).toBe("https://motion.example");
    expect(parseMotionApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => parseMotionApiUrl("http://motion.example")).toThrow("MOTION_API_URL");
    expect(() => parseMotionApiUrl("https://motion.example/?x=1")).toThrow("MOTION_API_URL");
  });

  it("keeps a Task view without the fields it cannot trust", () => {
    expect(toMotionTaskView({ id: "t" })).toBeNull();
    expect(toMotionTaskView({ id: "t", title: "x", labels: "nope", subtasks: [{}] })).toMatchObject(
      {
        labels: [],
        subtasks: [],
        project: null,
      }
    );
  });
});
