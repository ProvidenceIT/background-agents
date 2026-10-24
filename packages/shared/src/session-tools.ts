/**
 * Agent-facing session tool contract.
 *
 * The single definition of the session tools every harness exposes: telling the
 * session's owner something (`notify_user`), reading or annotating the motion
 * Task a session was delegated from (`motion_*`), and reading who owns the
 * session's repository (`repo_context`). Each tool is one control-plane
 * route below `/sessions/:id`, so no address, key or token ever enters the
 * sandbox. The pattern is `memory-tools.ts`'s: the sandbox runtime cannot import
 * TypeScript, so `npm run generate:session-tools-contract -w @open-inspect/shared`
 * writes the derived contract into the runtime package (a JSON file for Python,
 * an ES module for the OpenCode tools), and `session-tools.test.ts` fails when
 * they are stale.
 *
 * Every tool names a gate. The control plane resolves the session's enabled
 * gates at launch (none by default) and the runtime installs only the tools
 * whose gate is in that set; each route checks its own gate again on every
 * call, since sandbox admission grants nothing specific.
 */
import { z } from "zod";

/** What a deployment enables per repository; one gate can cover several tools. */
export const SESSION_TOOL_GATES = [
  "notify",
  "motion_read",
  "motion_write",
  "repo_context",
] as const;
export const sessionToolGateSchema = z.enum(SESSION_TOOL_GATES);
export type SessionToolGate = z.infer<typeof sessionToolGateSchema>;

export const SESSION_TOOL_NAMES = [
  "notify_user",
  "motion_get_task",
  "motion_add_note",
  "repo_context",
] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

/** A notice lands on a lock screen: short, and never a place for content. */
export const NOTIFY_USER_MESSAGE_MAX_CHARS = 500;
export const NOTIFY_USER_URGENCIES = ["normal", "high"] as const;
export type NotifyUserUrgency = (typeof NOTIFY_USER_URGENCIES)[number];

export const MOTION_NOTE_TITLE_MAX_CHARS = 120;
export const MOTION_NOTE_CONTENT_MAX_CHARS = 4000;

export const notifyUserInputSchema = z.strictObject({
  message: z
    .string()
    .min(1)
    .max(NOTIFY_USER_MESSAGE_MAX_CHARS)
    .describe(
      "What the owner needs to know, in one or two plain sentences. Mentions and links other than this deployment's and GitHub's are removed."
    ),
  urgency: z
    .enum(NOTIFY_USER_URGENCIES)
    .default("normal")
    .describe("Use high only when you are blocked until the owner acts."),
});
export type NotifyUserInput = z.output<typeof notifyUserInputSchema>;

export const motionGetTaskInputSchema = z.strictObject({});

export const motionAddNoteInputSchema = z.strictObject({
  title: z.string().min(1).max(MOTION_NOTE_TITLE_MAX_CHARS).describe("A short title for the note."),
  content: z
    .string()
    .min(1)
    .max(MOTION_NOTE_CONTENT_MAX_CHARS)
    .describe("The note body, plain text or Markdown."),
});
export type MotionAddNoteInput = z.output<typeof motionAddNoteInputSchema>;

export const repoContextInputSchema = z.strictObject({});

interface SessionToolDefinition {
  gate: SessionToolGate;
  description: string;
  input: z.ZodType;
  method: "GET" | "POST";
  /** Path below `/sessions/:id`; `{name}` segments are filled from (and consume) input fields. */
  path: string;
}

export const SESSION_TOOLS = {
  notify_user: {
    gate: "notify",
    description:
      "Send the session's owner a short direct message. Use it when you are blocked on a decision only they can make, or when a long task reaches a result they are waiting for; never for progress chatter. The server picks the recipient and channel; you cannot address anyone. Never include secrets, credentials, customer names or client data: the message can appear on a phone lock screen. At most 5 messages per session and 1 per minute.",
    input: notifyUserInputSchema,
    method: "POST",
    path: "/notify",
  },
  motion_get_task: {
    gate: "motion_read",
    description:
      "Read the motion Task this session was delegated from: its title, description, status, priority, due date, project, labels and subtasks. Available only in sessions motion started.",
    input: motionGetTaskInputSchema,
    method: "GET",
    path: "/motion/task",
  },
  motion_add_note: {
    gate: "motion_write",
    description:
      "Attach a note to the motion Task this session was delegated from, for example a summary of findings or a link to the pull request. It cannot change the Task's status; motion settles the Task when the session ends. Never include secrets or credentials.",
    input: motionAddNoteInputSchema,
    method: "POST",
    path: "/motion/notes",
  },
  repo_context: {
    gate: "repo_context",
    description:
      "Read who owns this session's repository and how careful to be with it: the owner team, the tier (T1 is the most critical, T3 the least), the class (playground, internal or client; an unclassified repository counts as client), its domain and dependencies, and the owners its CODEOWNERS file names. Use it before deciding whom a change affects or how much review it needs.",
    input: repoContextInputSchema,
    method: "GET",
    path: "/repo-context",
  },
} as const satisfies Record<SessionToolName, SessionToolDefinition>;

export interface SessionToolSpec {
  name: SessionToolName;
  gate: SessionToolGate;
  description: string;
  method: "GET" | "POST";
  path: string;
  inputSchema: Record<string, unknown>;
}

/** Everything the sandbox runtime needs from this contract, generated for every harness. */
export interface SessionToolsSandboxContract {
  tools: SessionToolSpec[];
  /** The environment variable carrying the session's enabled gates, comma-separated. */
  enabledGatesEnv: string;
}

/** Set on the sandbox by the control plane; absent or empty means no session tool. */
export const SESSION_TOOLS_ENV_VAR = "AGENT_SESSION_TOOLS";

/** Derive the harness-neutral contract from the zod schemas. */
export function buildSessionToolsSandboxContract(): SessionToolsSandboxContract {
  return {
    tools: SESSION_TOOL_NAMES.map((name) => {
      const tool = SESSION_TOOLS[name];
      const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input, {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
      return {
        name,
        gate: tool.gate,
        description: tool.description,
        method: tool.method,
        path: tool.path,
        inputSchema,
      };
    }),
    enabledGatesEnv: SESSION_TOOLS_ENV_VAR,
  };
}

/** The env value for a set of gates: sorted, deduplicated, comma-separated. */
export function formatSessionToolGates(gates: Iterable<SessionToolGate>): string {
  return [...new Set(gates)].sort().join(",");
}

const GENERATED_HEADER =
  "Generated from packages/shared/src/session-tools.ts by `npm run generate:session-tools-contract -w @open-inspect/shared`. Do not edit.";
/** Repo-relative output paths for {@link formatSessionToolsContractFiles}. */
export const SESSION_TOOLS_CONTRACT_FILES = {
  json: "packages/sandbox-runtime/src/sandbox_runtime/session_tools_contract.json",
  module: "packages/sandbox-runtime/src/sandbox_runtime/tools/_session-tools-contract.js",
} as const;

export function formatSessionToolsContractFiles(): Record<
  keyof typeof SESSION_TOOLS_CONTRACT_FILES,
  string
> {
  const contract = buildSessionToolsSandboxContract();
  const json = JSON.stringify(contract, null, 2);
  return {
    json: `${JSON.stringify({ $comment: GENERATED_HEADER, ...contract }, null, 2)}\n`,
    module: `// ${GENERATED_HEADER}\nexport const SESSION_TOOLS_CONTRACT = ${json};\n`,
  };
}
