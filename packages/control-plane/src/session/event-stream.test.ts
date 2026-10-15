import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import { SessionEventStream } from "./event-stream";
import { initSchema } from "./schema";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function toolCall(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  extra: Partial<ToolCallEvent> = {}
): ToolCallEvent {
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    timestamp: 1,
    tool,
    callId,
    args,
    status: "completed",
    ...extra,
  };
}

describe("SessionEventStream.getReplay", () => {
  it("sends the agent's plan calls from before the replay window", () => {
    const sql = createNodeSqlStorage(new DatabaseSync(":memory:")).sql;
    initSchema(sql);
    const repository = new EventRepository(sql, (closure) => closure());
    let createdAt = 1000;
    const add = (event: ToolCallEvent) =>
      repository.upsertToolCallEvent("message-1", event, createdAt++);

    add(toolCall("todo-1", "TodoWrite", { todos: [{ content: "Plan", status: "pending" }] }));
    add(toolCall("agent-1", "task", { description: "Review SQL" }));
    add(
      toolCall(
        "child-todo",
        "TodoWrite",
        { todos: [{ content: "Child", status: "pending" }] },
        { isSubtask: true, taskCallId: "agent-1" }
      )
    );
    for (let i = 0; i < 10; i++) add(toolCall(`bash-${i}`, "Bash", { command: "ls" }));

    const replay = new SessionEventStream(repository).getReplay(5);

    expect(replay.events.map((item) => item.event)).not.toContainEqual(
      expect.objectContaining({ callId: "agent-1" })
    );
    expect(
      replay.planEvents?.map((item) => {
        const event = item.event as ToolCallEvent;
        return [event.tool, event.callId];
      })
    ).toEqual([
      ["TodoWrite", "todo-1"],
      ["task", "agent-1"],
    ]);
  });
});
