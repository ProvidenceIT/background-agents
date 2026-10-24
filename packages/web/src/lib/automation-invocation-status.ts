import type { AutomationInvocationStatus } from "@open-inspect/shared/types/automations";

export type AutomationInvocationTone = "neutral" | "info" | "success" | "danger" | "warning";

export const AUTOMATION_INVOCATION_STATUS: Record<
  AutomationInvocationStatus,
  { label: string; tone: AutomationInvocationTone }
> = {
  starting: { label: "Starting", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  waiting_for_reset: { label: "Waiting for reset", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  unauthorized: { label: "Unauthorized", tone: "danger" },
  partial_failed: { label: "Partial failure", tone: "warning" },
  skipped: { label: "Skipped", tone: "warning" },
};

/** "Waiting for reset until 14:05": when a waiting run's session continues on its own. */
export function waitingForResetLabel(
  resumeAtMs: number,
  options: { locale?: string; timeZone?: string } = {}
): string {
  const clock = new Intl.DateTimeFormat(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).format(resumeAtMs);
  return `Waiting for reset until ${clock}`;
}
