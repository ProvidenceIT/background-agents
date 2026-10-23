/**
 * Session notices: what the control plane tells a session's owner when the
 * session settles, on channels other than the one that started it.
 *
 * The envelope is closed on purpose. A notice carries a status, a reason
 * code, the repository, a pull request link, the active time and a reset
 * time: never the session title, a prompt, agent text, an error string or a
 * cost. Titles and prompts can name clients, and a notice lands on a phone
 * lock screen. Adding a field is a deliberate change to this schema, not a
 * side effect of passing more data through.
 */

import { z } from "zod";
import { NOTIFY_USER_MESSAGE_MAX_CHARS, NOTIFY_USER_URGENCIES } from "./session-tools";

/**
 * Why a notice was raised. `limit_hit` and `recovery_needed` are failed
 * turns a person can act on: wait for the reset, or recover the sandbox.
 */
export const NOTICE_REASONS = ["completed", "failed", "limit_hit", "recovery_needed"] as const;
export const noticeReasonSchema = z.enum(NOTICE_REASONS);
export type NoticeReason = z.infer<typeof noticeReasonSchema>;

/** The session statuses that raise a notice; archive and cancel are a person's own act. */
export const NOTICE_STATUSES = ["completed", "failed"] as const;
export const noticeStatusSchema = z.enum(NOTICE_STATUSES);
export type NoticeStatus = z.infer<typeof noticeStatusSchema>;

const httpsUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

export const noticeEnvelopeSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  status: noticeStatusSchema,
  reason: noticeReasonSchema,
  /** `owner/name` of the primary repository, or null for a session without one. */
  repo: z.string().min(1).max(512).nullable(),
  prNumber: z.number().int().positive().nullable(),
  prUrl: httpsUrlSchema.nullable(),
  activeDurationMs: z.number().int().nonnegative().nullable(),
  /** When a usage limit resets; only meaningful for `limit_hit`. */
  resetsAtMs: z.number().int().nonnegative().nullable(),
});
export type NoticeEnvelope = z.infer<typeof noticeEnvelopeSchema>;

export interface NoticeRenderOptions {
  /** Base URL of the web app; the session link is left out without it. */
  webAppUrl?: string;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function formatDuration(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** `2026-10-23 14:05 UTC`: unambiguous for readers in any time zone. */
function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function headline(envelope: NoticeEnvelope, where: string): string {
  switch (envelope.reason) {
    case "completed":
      return `Your Open-Inspect session${where} completed.`;
    case "failed":
      return `Your Open-Inspect session${where} failed.`;
    case "limit_hit":
      return envelope.resetsAtMs === null
        ? `Your Open-Inspect session${where} stopped at a usage limit.`
        : `Your Open-Inspect session${where} stopped at a usage limit; it resets at ${formatUtc(envelope.resetsAtMs)}.`;
    case "recovery_needed":
      return `Your Open-Inspect session${where} needs recovery: its sandbox could not be saved. Open the session to choose a recovery action.`;
  }
}

/** The notice as plain text for a Teams direct message. */
export function renderTeamsNoticeText(
  envelope: NoticeEnvelope,
  options: NoticeRenderOptions
): string {
  const lines = [headline(envelope, envelope.repo ? ` in ${envelope.repo}` : "")];
  if (envelope.prNumber !== null && envelope.prUrl !== null) {
    lines.push(`PR #${envelope.prNumber}: ${envelope.prUrl}`);
  }
  if (envelope.activeDurationMs !== null && envelope.activeDurationMs > 0) {
    lines.push(`Active time: ${formatDuration(envelope.activeDurationMs)}`);
  }
  if (options.webAppUrl) {
    lines.push(`${options.webAppUrl.replace(/\/+$/, "")}/session/${envelope.sessionId}`);
  }
  return lines.join("\n");
}

/**
 * A notice the session's agent asked for (`notify_user`). It is the one notice
 * that carries words the agent chose, so the words are cleaned before they are
 * stored (`sanitizeAgentNoticeText`), kept only until the notice settles, and
 * audited as a hash and a length. Everything else is closed like the envelope.
 */
export const AGENT_NOTICE_KIND = "agent";
export const AGENT_NOTICE_TEXT_MAX_CHARS = NOTIFY_USER_MESSAGE_MAX_CHARS;

export const agentNoticeSchema = z.strictObject({
  kind: z.literal(AGENT_NOTICE_KIND),
  sessionId: z.string().min(1).max(128),
  /** `owner/name` of the primary repository, or null for a session without one. */
  repo: z.string().min(1).max(512).nullable(),
  urgency: z.enum(NOTIFY_USER_URGENCIES),
  /** Present until the notice settles (sent or failed); never in a shadow row. */
  text: z.string().min(1).max(AGENT_NOTICE_TEXT_MAX_CHARS).optional(),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  textLength: z.number().int().nonnegative(),
});
export type AgentNotice = z.infer<typeof agentNoticeSchema>;

export interface AgentNoticeSanitizeOptions {
  /** Hosts whose links survive, besides github.com: this deployment's web app. */
  allowedLinkHosts: readonly string[];
}

const LINK_REMOVED = "[link removed]";
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;
/** C0 controls but tab and newline, DEL, zero-width and bidi overrides. */
function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

function isAllowedLink(raw: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(raw.startsWith("www.") ? `https://${raw}` : raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return [...hosts, "github.com"].some(
      (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`)
    );
  } catch {
    return false;
  }
}

/**
 * The agent's words as a notice may carry them: plain text on at most a few
 * lines, no markup, no mention that could ping someone, and no link except to
 * this deployment or GitHub. A prompt-injected agent can still choose the
 * words, so the route that calls this is the only control: it never lets the
 * agent pick the recipient.
 */
export function sanitizeAgentNoticeText(raw: string, options: AgentNoticeSanitizeOptions): string {
  let text = raw.normalize("NFKC");
  // Teams mention entities and any other markup.
  text = text.replace(/<at>[\s\S]*?<\/at>/gi, "");
  text = text.replace(/<[^>]*>/g, "");
  // Markdown links keep their label; the target is judged like a bare link.
  text = text.replace(
    /!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g,
    (_match, label: string, target: string) =>
      isAllowedLink(target, options.allowedLinkHosts) ? `${label} ${target}` : label
  );
  text = text.replace(URL_PATTERN, (url) =>
    isAllowedLink(url, options.allowedLinkHosts) ? url : LINK_REMOVED
  );
  // @everyone, @channel and @handles lose the sigil.
  text = text.replace(/(^|[^\w@])@(?=[\w.-])/g, "$1");
  // Control and zero-width characters, then whitespace runs and blank lines.
  text = [...text].filter((char) => !isInvisible(char)).join("");
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, 6)
    .join("\n");
  return text.slice(0, AGENT_NOTICE_TEXT_MAX_CHARS).trim();
}

/** The agent's notice as plain text for a Teams direct message. */
export function renderTeamsAgentNoticeText(
  notice: AgentNotice & { text: string },
  options: NoticeRenderOptions
): string {
  const where = notice.repo ? ` in ${notice.repo}` : "";
  const lines = [
    notice.urgency === "high"
      ? `From your Open-Inspect agent${where} (needs you):`
      : `From your Open-Inspect agent${where}:`,
    notice.text,
  ];
  if (options.webAppUrl) {
    lines.push(`${options.webAppUrl.replace(/\/+$/, "")}/session/${notice.sessionId}`);
  }
  return lines.join("\n");
}
