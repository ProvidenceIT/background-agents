/**
 * Task extraction utilities: the agent's checklist, from TodoWrite or the Task* tools,
 * and the subagents it launched
 */

import { toolCallIdentityKey } from "@open-inspect/shared/types/sandbox-events";
import { isSubtaskRootTool } from "@/lib/tool-formatters";
import type { SandboxEvent, Task } from "@/types/session";
import { z } from "zod";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

const todoWriteArgsSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().optional(),
        status: z.string().optional(),
        activeForm: z.string().optional(),
      })
    )
    .optional(),
});

const taskCreateArgsSchema = z.object({
  subject: z.string().optional(),
  activeForm: z.string().optional(),
});

const taskUpdateArgsSchema = z.object({
  taskId: z.union([z.string(), z.number()]).transform(String),
  subject: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.string().optional(),
});

/** Claude Code answers a TaskCreate with "Task #<id> created successfully: <subject>". */
const TASK_CREATED_OUTPUT = /^Task #(\S+) created successfully/;

function normalizeTaskStatus(status: string | undefined): Task["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

function toolName(event: ToolCallEvent): string {
  // Case-insensitive: OpenCode may report tool names in lowercase.
  return event.tool?.toLowerCase() ?? "";
}

function argsTruncated(event: ToolCallEvent): boolean {
  return event.truncated?.fields.some((field) => field.startsWith("args.")) ?? false;
}

/**
 * One event per top-level tool call, at its first position, carrying its latest
 * state. Calls made inside a subagent are its own business, not the session's plan.
 */
function latestToolCalls(events: SandboxEvent[]): ToolCallEvent[] {
  const calls: ToolCallEvent[] = [];
  const indexes = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "tool_call" || !event.callId || event.isSubtask) continue;
    const key = toolCallIdentityKey(event);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, calls.length);
      calls.push(event);
    } else {
      calls[index] = event;
    }
  }
  return calls;
}

function tasksFromTodoWrite(call: ToolCallEvent): Task[] {
  if (argsTruncated(call)) return [];
  const parsedArgs = todoWriteArgsSchema.safeParse(call.args);
  if (!parsedArgs.success || !parsedArgs.data.todos) return [];
  return parsedArgs.data.todos.map((todo) => ({
    content: todo.content || "",
    status: normalizeTaskStatus(todo.status),
    activeForm: todo.activeForm,
  }));
}

/**
 * Replays TaskCreate/TaskUpdate calls into the list they built. Claude Code uses
 * these instead of TodoWrite once its task list is enabled.
 */
function tasksFromTaskTools(calls: ToolCallEvent[]): Task[] {
  const tasks = new Map<string, Task>();
  for (const call of calls) {
    if (call.status === "error" || argsTruncated(call)) continue;
    const name = toolName(call);
    if (name === "taskcreate") {
      const args = taskCreateArgsSchema.safeParse(call.args);
      if (!args.success) continue;
      // Until the result names the task, the call id keeps it in place.
      const id = TASK_CREATED_OUTPUT.exec(call.output ?? "")?.[1] ?? `call:${call.callId}`;
      tasks.set(id, {
        content: args.data.subject ?? "",
        status: "pending",
        activeForm: args.data.activeForm,
      });
    } else if (name === "taskupdate") {
      const args = taskUpdateArgsSchema.safeParse(call.args);
      if (!args.success) continue;
      const { taskId, status, subject, activeForm } = args.data;
      if (status === "deleted") {
        tasks.delete(taskId);
        continue;
      }
      const task = tasks.get(taskId);
      if (!task) continue;
      tasks.set(taskId, {
        content: subject ?? task.content,
        status: status ? normalizeTaskStatus(status) : task.status,
        activeForm: activeForm ?? task.activeForm,
      });
    }
  }
  return [...tasks.values()];
}

/**
 * Extract the latest task list from sandbox events: the last TodoWrite snapshot,
 * or the list the Task* tools built when they were used after it.
 */
export function extractLatestTasks(events: SandboxEvent[]): Task[] {
  const calls = latestToolCalls(events);
  let lastTodoWrite = -1;
  let lastTaskTool = -1;
  calls.forEach((call, index) => {
    const name = toolName(call);
    if (name === "todowrite") lastTodoWrite = index;
    else if (name === "taskcreate" || name === "taskupdate") lastTaskTool = index;
  });

  if (lastTaskTool > lastTodoWrite) {
    return tasksFromTaskTools(calls.slice(lastTodoWrite + 1));
  }
  return lastTodoWrite === -1 ? [] : tasksFromTodoWrite(calls[lastTodoWrite]);
}

const SUBAGENT_STATUS: Record<string, Task["status"]> = {
  completed: "completed",
  error: "failed",
};

/** The subagents the agent launched, in launch order, with each one's latest state. */
export function extractSubagents(events: SandboxEvent[]): Task[] {
  return latestToolCalls(events)
    .filter((call) => isSubtaskRootTool(call.tool))
    .map((call) => ({
      content: typeof call.args.description === "string" ? call.args.description : "Subagent",
      status: SUBAGENT_STATUS[call.status ?? ""] ?? "in_progress",
    }));
}
