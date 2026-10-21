import type { PermissionId } from "@open-inspect/shared/rbac";
import type { ServiceName } from "@open-inspect/shared/service-auth";

// Service actors need a ceiling grant as well as an actor role grant (which may
// come from a custom role). Bot ceilings omit sessions.export even for such actors.
const SERVICE_PERMISSION_CEILINGS: Record<ServiceName, readonly PermissionId[]> = {
  web: [],
  "github-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
  "slack-bot": [
    "automations.read",
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "sessions.sandbox_access",
    "skills.read",
  ],
  "linear-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
  // The Teams bot renders completions from callbacks and never reaches into a sandbox.
  "teams-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
  // Providence acts for one signed-in person on the few routes that opt it in
  // (OPT_IN_SERVICES); the ceiling also caps the handlers' target checks.
  motion: [
    "repositories.use",
    "environments.use",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
  ],
  // The prompt-library sync imports reviewed skills for one signed-in person on
  // the skill routes that opt it in; the handlers also pin its sources
  // (skills/prompt-library-sources.ts).
  "prompt-library": ["skills.read", "skills.manage"],
  // The sandbox canary (deploy healthcheck) creates an empty session for one signed-in
  // person, reads its sandbox status and archives it; session-create pins it to a
  // title-only body, and no prompt route opts it in.
  healthcheck: ["sessions.create", "sessions.read", "sessions.lifecycle"],
};

/** Checks the hard permission ceiling for a trusted service, independent of user grants. */
export function serviceAllowsPermission(service: ServiceName, permission: PermissionId): boolean {
  return SERVICE_PERMISSION_CEILINGS[service].includes(permission);
}

/**
 * Services admitted only on routes that name them in `optInServices`; every
 * other route refuses them before actor enrolment, whatever their ceiling.
 * On session routes they read any session the acting user may read, but every
 * other action reaches only the sessions they created for that user (see
 * `enforceSessionRequirement`). On skill routes the prompt-library service
 * reaches only skills imported from its allowlisted repositories, pinned to a
 * commit (see `skills/prompt-library-sources.ts`).
 */
export const OPT_IN_SERVICES = [
  "motion",
  "prompt-library",
  "healthcheck",
] as const satisfies readonly ServiceName[];
export type OptInServiceName = (typeof OPT_IN_SERVICES)[number];

export function isOptInService(service: ServiceName): service is OptInServiceName {
  return (OPT_IN_SERVICES as readonly string[]).includes(service);
}
