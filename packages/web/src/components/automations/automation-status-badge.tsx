import type { Automation } from "@open-inspect/shared/types/automations";
import { assessRunnability, selectedProviderAuthModes } from "@open-inspect/shared/harnesses";
import { Badge } from "@/components/ui/badge";

export function AutomationStatusBadge({ automation }: { automation: Automation }) {
  // A saved setup that cannot run fails every run unattended; say so first.
  const runnability = assessRunnability(
    automation.harness,
    automation.model,
    selectedProviderAuthModes(automation.providerSelections)
  );
  if (!runnability.runnable) {
    return (
      <Badge
        className="bg-warning-muted text-warning"
        title={runnability.reasons.map((reason) => reason.message).join(" ")}
      >
        Cannot run
      </Badge>
    );
  }
  if (automation.enabled && automation.consecutiveFailures > 0) {
    return (
      <Badge className="bg-warning-muted text-warning">
        Degraded ({automation.consecutiveFailures} failures)
      </Badge>
    );
  }
  if (automation.enabled) {
    return <Badge className="bg-success-muted text-success">Enabled</Badge>;
  }
  return <Badge className="bg-muted text-muted-foreground">Paused</Badge>;
}
