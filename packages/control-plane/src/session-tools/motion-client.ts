/**
 * The control plane's client for motion's REST v1, used by the agent's
 * `motion_*` session tools. The key (`MOTION_API_KEY`, an `mk_` workspace key
 * with TASKS_READ and NOTES_WRITE only) stays here; the agent never sees it,
 * never names a Task, and cannot write a Task's status: this client has no
 * call that could.
 *
 * A session motion started carries `externalRef = providence/delegated-work/<id>`
 * (motion's `delegated-work/keys.ts`). The Task is resolved from that row by
 * motion itself, so a session can only ever reach the Task it was delegated
 * from. motion answers `{ success, data }` or `{ success: false, error }`,
 * authenticated with `Authorization: Bearer <key>`.
 */

/** motion's prefix for the refs it gives the sessions it delegates. */
const DELEGATED_WORK_REF_PREFIX = "providence/delegated-work/";
export const MOTION_REQUEST_TIMEOUT_MS = 10_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `MOTION_API_URL` as a base URL without a trailing slash: `https:`, or
 * `http:` to this machine only, with no query or fragment.
 */
export function parseMotionApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MOTION_API_URL must be an absolute https URL, got ${raw}`);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error(`MOTION_API_URL must be an https URL (http only to localhost), got ${raw}`);
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new Error(`MOTION_API_URL must not carry a query or fragment, got ${raw}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The DelegatedWork id a motion ref names, or null when the ref is not one. */
export function delegatedWorkIdFromRef(externalRef: string): string | null {
  if (!externalRef.startsWith(DELEGATED_WORK_REF_PREFIX)) return null;
  const id = externalRef.slice(DELEGATED_WORK_REF_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** What the agent sees of a Task: its brief, never who is assigned or their email. */
export interface MotionTaskView {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  project: string | null;
  labels: string[];
  subtasks: Array<{ title: string; completed: boolean }>;
}

export type MotionFailure =
  /** The delegated work has no Task (or motion does not know the row). */
  | "not_linked"
  /** motion refused the key: missing, revoked or without the scope. */
  | "unauthorized"
  | "rate_limited"
  /** motion could not be reached, timed out or answered something unexpected. */
  | "unavailable";

export type MotionResult<T> = { ok: true; value: T } | { ok: false; reason: MotionFailure };

export interface MotionTaskClient {
  getTask(delegatedWorkId: string): Promise<MotionResult<MotionTaskView>>;
  addNote(
    delegatedWorkId: string,
    note: { title: string; content: string }
  ): Promise<MotionResult<{ noteId: string }>>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pick the brief out of motion's full Task; anything unexpected is left out. */
export function toMotionTaskView(raw: unknown): MotionTaskView | null {
  const task = record(raw);
  const id = stringOrNull(task?.id);
  const title = stringOrNull(task?.title);
  if (!task || !id || !title) return null;
  const labels = Array.isArray(task.labels)
    ? task.labels
        .map((entry) => stringOrNull(record(record(entry)?.label)?.name ?? record(entry)?.name))
        .filter((name): name is string => name !== null)
    : [];
  const subtasks = Array.isArray(task.subtasks)
    ? task.subtasks.flatMap((entry) => {
        const subtask = record(entry);
        const subtaskTitle = stringOrNull(subtask?.title);
        return subtaskTitle
          ? [{ title: subtaskTitle, completed: subtask?.completed === true }]
          : [];
      })
    : [];
  return {
    id,
    title,
    description: stringOrNull(task.description),
    status: stringOrNull(task.status),
    priority: stringOrNull(task.priority),
    dueDate: stringOrNull(task.dueDate),
    project: stringOrNull(record(task.project)?.name),
    labels,
    subtasks,
  };
}

function failureFor(status: number): MotionFailure {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_linked";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export function createMotionTaskClient(deps: {
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
}): MotionTaskClient {
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<MotionResult<unknown>> {
    let response: Response;
    try {
      response = await doFetch(`${deps.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(MOTION_REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!response.ok) return { ok: false, reason: failureFor(response.status) };
    try {
      const parsed = record(await response.json());
      if (parsed?.success !== true) return { ok: false, reason: "unavailable" };
      return { ok: true, value: parsed.data };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async function taskIdFor(delegatedWorkId: string): Promise<MotionResult<string>> {
    const result = await call(
      "GET",
      `/api/v1/open-inspect/delegated-work/${encodeURIComponent(delegatedWorkId)}`
    );
    if (!result.ok) return result;
    const taskId = stringOrNull(record(result.value)?.taskId);
    return taskId ? { ok: true, value: taskId } : { ok: false, reason: "not_linked" };
  }

  return {
    async getTask(delegatedWorkId) {
      const taskId = await taskIdFor(delegatedWorkId);
      if (!taskId.ok) return taskId;
      const result = await call("GET", `/api/v1/tasks/${encodeURIComponent(taskId.value)}`);
      if (!result.ok) return result;
      const view = toMotionTaskView(result.value);
      return view ? { ok: true, value: view } : { ok: false, reason: "unavailable" };
    },

    async addNote(delegatedWorkId, note) {
      const taskId = await taskIdFor(delegatedWorkId);
      if (!taskId.ok) return taskId;
      const result = await call("POST", "/api/v1/notes", {
        title: note.title,
        content: note.content,
        taskId: taskId.value,
      });
      if (!result.ok) return result;
      const noteId = stringOrNull(record(result.value)?.id);
      return noteId ? { ok: true, value: { noteId } } : { ok: false, reason: "unavailable" };
    },
  };
}
