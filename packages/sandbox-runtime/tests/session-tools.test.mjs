import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

process.env.CONTROL_PLANE_URL = "https://control.test";
process.env.SANDBOX_AUTH_TOKEN = "sandbox-token";
process.env.SESSION_CONFIG = JSON.stringify({ sessionId: "bound-session" });

const requests = [];
function respondWith(response) {
  requests.length = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return response.clone();
  };
}

const { sessionToolDefinition } = await import("../src/sandbox_runtime/tools/_session-tool.js");
const { SESSION_TOOLS_CONTRACT } =
  await import("../src/sandbox_runtime/tools/_session-tools-contract.js");

const toolsDir = new URL("../src/sandbox_runtime/tools/", import.meta.url);

/** Records the zod builder calls; the plugin's zod is not installed here. */
function recordingSchema() {
  const node = (calls) =>
    new Proxy(
      { calls },
      {
        get: (target, method) =>
          method === "calls"
            ? target.calls
            : (...args) => node([...target.calls, [method, ...args]]),
      }
    );
  return {
    string: () => node([["string"]]),
    number: () => node([["number"]]),
    enum: (values) => node([["enum", values]]),
  };
}

test("every session tool has a tool file named for it that uses the factory", () => {
  const files = new Set(readdirSync(toolsDir));
  for (const spec of SESSION_TOOLS_CONTRACT.tools) {
    assert.ok(files.has(`${spec.name}.js`), `${spec.name}.js is missing`);
    const source = readFileSync(new URL(`${spec.name}.js`, toolsDir), "utf8");
    assert.match(source, new RegExp(`sessionToolDefinition\\(tool\\.schema, "${spec.name}"\\)`));
  }
});

test("every spec converts and exposes its description", () => {
  for (const spec of SESSION_TOOLS_CONTRACT.tools) {
    const definition = sessionToolDefinition(recordingSchema(), spec.name);
    assert.equal(definition.description, spec.description);
    assert.deepEqual(Object.keys(definition.args), Object.keys(spec.inputSchema.properties));
  }
});

test("notify_user posts only the declared fields, never a recipient", async () => {
  respondWith(Response.json({ status: "queued" }, { status: 202 }));
  const { execute } = sessionToolDefinition(recordingSchema(), "notify_user");

  await execute({ message: "PR ready", urgency: "normal", recipient: "someone@example.com" });

  assert.equal(requests[0].url, "https://control.test/sessions/bound-session/notify");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    message: "PR ready",
    urgency: "normal",
  });
});

test("motion_get_task is a bodiless GET and reports refusals as text", async () => {
  respondWith(Response.json({ error: "Not a motion session" }, { status: 403 }));
  const { execute } = sessionToolDefinition(recordingSchema(), "motion_get_task");

  const output = await execute({ taskId: "other-task" });

  assert.equal(requests[0].url, "https://control.test/sessions/bound-session/motion/task");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.body, undefined);
  assert.equal(output, "motion_get_task failed (403): Not a motion session");
});
