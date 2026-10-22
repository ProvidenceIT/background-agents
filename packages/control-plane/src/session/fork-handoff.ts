import type { SandboxEvent, TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
import { FORK_HANDOFF_MAX_CHARS } from "@open-inspect/shared/types/session-api";

export const FORK_CONSENT_LINE =
  "Consent does not carry over: ask before pushing, opening PRs or deploying.";

const TRUNCATION_MARKER = "\n…[truncated]";
const FIRST_PROMPT_MAX_CHARS = 12_000;
const LATER_PROMPT_MAX_CHARS = 4_000;
const LATER_PROMPTS_SHOWN = 5;
const PLAN_MAX_CHARS = 4_000;
const STOP_REASON_MAX_CHARS = 2_000;
const ASSISTANT_MESSAGE_MAX_CHARS = 4_000;
const ASSISTANT_MESSAGES_SHOWN = 3;
const FILES_TOUCHED_SHOWN = 50;

const FILE_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const FILE_PATH_ARGS = ["file_path", "filePath", "path", "notebook_path"] as const;

const WINDOW_LABELS: Record<TurnLimit["window"], string> = {
  five_hour: "five-hour window",
  seven_day: "seven-day window",
  seven_day_opus: "seven-day Opus window",
  seven_day_sonnet: "seven-day Sonnet window",
  overage: "overage",
  unknown: "unknown window",
};

/** One member repository as the fork needs it. */
export type ForkRepository = Pick<
  SessionRepositoryState,
  "repoOwner" | "repoName" | "baseBranch" | "branchName"
>;

export interface ForkHandoffSource {
  sessionId: string;
  title: string | null;
  repositories: ForkRepository[];
  lastTurnLimit: TurnLimit | null;
  /** The source's timeline, oldest first. */
  events: SandboxEvent[];
  /** Plan tool calls from the whole history when `events` is only its recent part. */
  planEvents?: SandboxEvent[];
  /** The user's prompts, oldest first. */
  prompts: string[];
  /** Whether prompts older than `prompts[0]` exist but were not read. */
  promptsTruncated: boolean;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function describeLimit(limit: TurnLimit): string {
  const slot = limit.subscriptionSlot ? `, slot ${limit.subscriptionSlot}` : "";
  const resets =
    limit.resetsAtMs === null
      ? "The reset time is unknown."
      : `It resets at ${new Date(limit.resetsAtMs).toISOString()}.`;
  return `The ${limit.harness} subscription limit stopped the last turn (${WINDOW_LABELS[limit.window]}${slot}). ${resets}`;
}

type ToolCall = Extract<SandboxEvent, { type: "tool_call" }>;

function topLevelToolCalls(events: SandboxEvent[]): ToolCall[] {
  const latest = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== "tool_call" || event.isSubtask) continue;
    // A call is upserted as it progresses; the last copy carries its final args.
    latest.delete(event.callId);
    latest.set(event.callId, event);
  }
  return [...latest.values()];
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function planLines(events: SandboxEvent[]): string[] {
  const calls = topLevelToolCalls(events).filter((call) => call.status !== "error");
  let lastTodoWrite = -1;
  calls.forEach((call, index) => {
    if (call.tool.toLowerCase() === "todowrite") lastTodoWrite = index;
  });
  const tasks = new Map<string, { content: string; status: string }>();
  if (lastTodoWrite >= 0) {
    const todos = calls[lastTodoWrite].args.todos;
    if (Array.isArray(todos)) {
      todos.forEach((todo, index) => {
        if (typeof todo !== "object" || todo === null) return;
        const record = todo as Record<string, unknown>;
        tasks.set(`todo:${index}`, {
          content: stringField(record, "content") ?? "",
          status: stringField(record, "status") ?? "pending",
        });
      });
    }
  }
  for (const call of calls.slice(lastTodoWrite + 1)) {
    const name = call.tool.toLowerCase();
    if (name === "taskcreate") {
      const id = /^Task #(\S+) created/.exec(call.output ?? "")?.[1] ?? `call:${call.callId}`;
      tasks.set(id, { content: stringField(call.args, "subject") ?? "", status: "pending" });
    } else if (name === "taskupdate") {
      const id = call.args.taskId === undefined ? null : String(call.args.taskId);
      const task = id ? tasks.get(id) : undefined;
      if (!id || !task) continue;
      const status = stringField(call.args, "status");
      if (status === "deleted") tasks.delete(id);
      else
        tasks.set(id, {
          content: stringField(call.args, "subject") ?? task.content,
          status: status ?? task.status,
        });
    }
  }
  return [...tasks.values()]
    .filter((task) => task.content)
    .map((task) => `- [${task.status}] ${task.content}`);
}

function assistantMessages(events: SandboxEvent[]): string[] {
  return events
    .filter((event): event is Extract<SandboxEvent, { type: "token" }> => event.type === "token")
    .map((event) => event.content.trim())
    .filter(Boolean);
}

function filesTouched(events: SandboxEvent[]): string[] {
  const files: string[] = [];
  for (const call of topLevelToolCalls(events)) {
    if (!FILE_EDIT_TOOLS.has(call.tool.toLowerCase()) || call.status === "error") continue;
    const path = FILE_PATH_ARGS.map((key) => stringField(call.args, key)).find(Boolean);
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

function lastCompletion(
  events: SandboxEvent[]
): Extract<SandboxEvent, { type: "execution_complete" }> | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "execution_complete") return event;
  }
  return null;
}

/**
 * The branch a fork of this repository starts from: the source's pushed work
 * branch, or its base branch when nothing was pushed.
 */
export function forkStartBranch(repository: ForkRepository): string {
  return repository.branchName ?? repository.baseBranch;
}

function repositoryLine(repository: ForkRepository): string {
  const name = `${repository.repoOwner}/${repository.repoName}`;
  const base = repository.baseBranch;
  const work = repository.branchName;
  if (!work) {
    return `- ${name}: starts from base branch \`${base}\`. Nothing was pushed, so unpushed work from the original sandbox is not here.`;
  }
  return `- ${name}: starts from \`${work}\`, the branch the original session pushed its work to. Pull requests from this session target \`${base}\`, the original base branch.`;
}

/**
 * The first prompt of a fork: a markdown handoff drafted from the source
 * session's stored record. Deterministic for a given source and never longer
 * than FORK_HANDOFF_MAX_CHARS; the consent rule always survives truncation.
 */
export function buildForkHandoff(source: ForkHandoffSource): string {
  const title = source.title?.trim() || "Untitled session";
  const header = [
    `# Handoff from "${title}"`,
    "",
    `You are continuing the work of another Open Inspect session (${source.sessionId}) in a new session. The original session stays open. What follows is a summary of its record: treat it as a claim and check the repository before relying on it.`,
  ].join("\n");
  const footer = [
    "## Rules that still apply",
    "",
    FORK_CONSENT_LINE,
    "Start by checking `git status` and `git log` against the summary above, then continue the task.",
  ].join("\n");

  const sections: string[] = [];
  if (source.repositories.length > 0) {
    sections.push(["## Repositories", "", ...source.repositories.map(repositoryLine)].join("\n"));
  }

  const [firstPrompt, ...laterPrompts] = source.prompts;
  if (firstPrompt !== undefined) {
    const heading = source.promptsTruncated ? "## Earliest prompt read" : "## Original request";
    sections.push(`${heading}\n\n${quote(truncate(firstPrompt, FIRST_PROMPT_MAX_CHARS))}`);
  }
  if (laterPrompts.length > 0) {
    const shown = laterPrompts.slice(-LATER_PROMPTS_SHOWN);
    const omitted = laterPrompts.length - shown.length;
    sections.push(
      [
        "## Later prompts",
        ...(omitted > 0 ? ["", `(${omitted} earlier prompts omitted.)`] : []),
        ...shown.map(
          (prompt, index) =>
            `\n${omitted + index + 2}.\n${quote(truncate(prompt, LATER_PROMPT_MAX_CHARS))}`
        ),
      ].join("\n")
    );
  }

  const plan = planLines([...(source.planEvents ?? []), ...source.events]);
  if (plan.length > 0) {
    sections.push(`## Plan as last recorded\n\n${truncate(plan.join("\n"), PLAN_MAX_CHARS)}`);
  }

  const messages = assistantMessages(source.events).slice(-ASSISTANT_MESSAGES_SHOWN);
  if (messages.length > 0) {
    sections.push(
      [
        "## Recent assistant messages",
        ...messages.map((message) => `\n${quote(truncate(message, ASSISTANT_MESSAGE_MAX_CHARS))}`),
      ].join("\n")
    );
  }

  const completion = lastCompletion(source.events);
  const limit = source.lastTurnLimit ?? (completion?.success ? null : (completion?.limit ?? null));
  const stopLines: string[] = [];
  if (completion && !completion.success) {
    stopLines.push(
      completion.error ? `The last turn failed: ${completion.error}` : "The last turn failed."
    );
  }
  if (limit) stopLines.push(describeLimit(limit));
  if (stopLines.length > 0) {
    sections.push(
      `## Where it stopped\n\n${truncate(stopLines.join("\n"), STOP_REASON_MAX_CHARS)}`
    );
  }

  const files = filesTouched(source.events);
  if (files.length > 0) {
    const shown = files.slice(0, FILES_TOUCHED_SHOWN);
    const more = files.length - shown.length;
    sections.push(
      [
        "## Files edited",
        "",
        ...shown.map((file) => `- ${file}`),
        ...(more > 0 ? [`- …and ${more} more`] : []),
      ].join("\n")
    );
  }

  const separator = "\n\n";
  const bodyBudget = FORK_HANDOFF_MAX_CHARS - header.length - footer.length - separator.length * 2;
  const body = truncate(sections.join(separator), bodyBudget);
  return [header, body, footer].filter(Boolean).join(separator);
}
