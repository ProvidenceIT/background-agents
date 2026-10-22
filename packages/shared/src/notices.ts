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
