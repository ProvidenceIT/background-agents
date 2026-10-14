import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { extractLatestTasks } from "./tasks";

let timestamp = 0;

function toolCall(
  tool: string,
  callId: string,
  args: Record<string, unknown>,
  result: { status?: string; output?: string } = {}
): SandboxEvent {
  timestamp += 1;
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    timestamp,
    tool,
    callId,
    args,
    ...result,
  };
}

function created(callId: string, id: string, subject: string, activeForm?: string) {
  return toolCall(
    "TaskCreate",
    callId,
    { subject, description: `Do: ${subject}`, ...(activeForm ? { activeForm } : {}) },
    { status: "completed", output: `Task #${id} created successfully: ${subject}` }
  );
}

describe("extractLatestTasks", () => {
  it("returns nothing without a task tool call", () => {
    expect(extractLatestTasks([toolCall("Bash", "call-1", { command: "ls" })])).toEqual([]);
  });

  it("reads the latest TodoWrite snapshot", () => {
    expect(
      extractLatestTasks([
        toolCall("TodoWrite", "call-1", { todos: [{ content: "Old", status: "pending" }] }),
        toolCall("todowrite", "call-2", {
          todos: [
            { content: "Read", status: "completed" },
            { content: "Write", status: "in_progress", activeForm: "Writing" },
          ],
        }),
      ])
    ).toEqual([
      { content: "Read", status: "completed", activeForm: undefined },
      { content: "Write", status: "in_progress", activeForm: "Writing" },
    ]);
  });

  it("builds the checklist from Claude Code's TaskCreate and TaskUpdate calls", () => {
    expect(
      extractLatestTasks([
        created("call-1", "1", "Read the code", "Reading the code"),
        created("call-2", "2", "Fix the parser"),
        created("call-3", "3", "Drop the shim"),
        toolCall("TaskUpdate", "call-4", { taskId: "1", status: "completed" }),
        toolCall("TaskUpdate", "call-5", { taskId: "2", status: "in_progress" }),
        toolCall("TaskUpdate", "call-6", { taskId: "3", status: "deleted" }),
      ])
    ).toEqual([
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Fix the parser", status: "in_progress", activeForm: undefined },
    ]);
  });

  it("uses the latest state of each call and keeps a running TaskCreate in place", () => {
    const running = toolCall("TaskCreate", "call-1", { subject: "Read" }, { status: "running" });
    expect(extractLatestTasks([running])).toEqual([
      { content: "Read", status: "pending", activeForm: undefined },
    ]);
    expect(
      extractLatestTasks([
        running,
        created("call-1", "1", "Read"),
        toolCall("TaskUpdate", "call-2", { taskId: "1", subject: "Read it all" }),
      ])
    ).toEqual([{ content: "Read it all", status: "pending", activeForm: undefined }]);
  });

  it("ignores failed calls and updates to unknown tasks", () => {
    expect(
      extractLatestTasks([
        created("call-1", "1", "Read"),
        toolCall("TaskCreate", "call-2", { subject: "Broken" }, { status: "error", output: "x" }),
        toolCall(
          "TaskUpdate",
          "call-3",
          { taskId: "1", status: "completed" },
          { status: "error", output: "denied" }
        ),
        toolCall("TaskUpdate", "call-4", { taskId: "9", status: "completed" }),
      ])
    ).toEqual([{ content: "Read", status: "pending", activeForm: undefined }]);
  });

  it("follows whichever task tool the agent used last", () => {
    const todo = toolCall("TodoWrite", "call-1", {
      todos: [{ content: "Todo", status: "pending" }],
    });
    const task = created("call-2", "1", "Task");
    expect(extractLatestTasks([todo, task]).map((t) => t.content)).toEqual(["Task"]);
    const laterTodo = toolCall("TodoWrite", "call-3", {
      todos: [{ content: "Todo again", status: "pending" }],
    });
    expect(extractLatestTasks([todo, task, laterTodo]).map((t) => t.content)).toEqual([
      "Todo again",
    ]);
  });
});
