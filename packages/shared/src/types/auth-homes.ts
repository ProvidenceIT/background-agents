import { z } from "zod";
import { extractProviderAndModel } from "../models";
import { SUBSCRIPTION_PROVIDER_IDS, type SubscriptionProviderId } from "./provider-accounts";

/**
 * Subscription auth homes.
 *
 * An auth home is a directory on a node the subscriber administers, mounted
 * into a sandbox as a persistent volume claim, from which the provider's own
 * CLI reads the subscriber's subscription credential. The control plane never
 * holds, forwards or refreshes that credential: it only keeps this registry
 * (who owns the home, which providers it carries, what it consents to) and
 * decides per turn which home, if any, a session may mount.
 *
 * There is no API key anywhere. A turn with no eligible home is refused.
 */

/** What started a session; the first element is the only one a human can start. */
export const TRIGGER_KINDS = [
  "prompt",
  "child",
  "mention",
  "issue_label",
  "pr_event",
  "schedule",
] as const;
export const triggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof triggerKindSchema>;

/**
 * Workspace policy for spending a home on another enrolled person's activity.
 * `household` (the default) lets the resolver fall back to a home its owner
 * switched to `shared`; `owner_only` restores own-home-or-refuse.
 */
export const SUBSCRIPTION_SHARING_POLICIES = ["owner_only", "household"] as const;
export const subscriptionSharingPolicySchema = z.enum(SUBSCRIPTION_SHARING_POLICIES);
export type SubscriptionSharingPolicy = z.infer<typeof subscriptionSharingPolicySchema>;
export const DEFAULT_SUBSCRIPTION_SHARING_POLICY: SubscriptionSharingPolicy = "household";

export const subscriptionSharingSchema = z.strictObject({
  policy: subscriptionSharingPolicySchema,
  /** Null until an Owner or Administrator has written the setting. */
  updatedBy: z.string().min(1).nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
});
export type SubscriptionSharing = z.infer<typeof subscriptionSharingSchema>;

export const putSubscriptionSharingRequestSchema = z.strictObject({
  policy: subscriptionSharingPolicySchema,
});
export type PutSubscriptionSharingRequest = z.infer<typeof putSubscriptionSharingRequestSchema>;

/** `disabled` keeps the registration but makes the home ineligible for every turn. */
export const AUTH_HOME_STATUSES = ["active", "disabled"] as const;
export const authHomeStatusSchema = z.enum(AUTH_HOME_STATUSES);
export type AuthHomeStatus = z.infer<typeof authHomeStatusSchema>;

/** Which rule of the resolver chose a session's home; stored on the session. */
export const AUTH_HOME_SELECTIONS = ["own", "shared"] as const;
export const authHomeSelectionSchema = z.enum(AUTH_HOME_SELECTIONS);
export type AuthHomeSelection = z.infer<typeof authHomeSelectionSchema>;

/** `session_model_provider_auth.selection_source` values written for `auth_home` rows. */
export const AUTH_HOME_SELECTION_SOURCES = {
  own: "auth_home_own",
  shared: "auth_home_shared",
} as const satisfies Record<AuthHomeSelection, string>;
export type AuthHomeSelectionSource =
  (typeof AUTH_HOME_SELECTION_SOURCES)[keyof typeof AUTH_HOME_SELECTION_SOURCES];

/**
 * Persistent volume claims that carry a home are named `sf-home-<suffix>`;
 * the admission policy admits exactly one such claim per pod and requires the
 * pod's owner label to equal the suffix. A DNS-1123 label, so at most 63
 * characters in total.
 */
export const AUTH_HOME_PVC_NAME_PREFIX = "sf-home-";
export const AUTH_HOME_PVC_NAME_PATTERN = /^sf-home-[a-z0-9]([a-z0-9-]{0,53}[a-z0-9])?$/;
export const authHomePvcNameSchema = z.string().regex(AUTH_HOME_PVC_NAME_PATTERN);

export const AUTH_HOME_MAX_OWNERS = 8;
export const AUTH_HOME_DEFAULT_MAX_CONCURRENT = 3;
export const AUTH_HOME_MAX_CONCURRENT_LIMIT = 32;

/**
 * Providers a home can carry: the subscription providers whose CLI reads a
 * credential file from the home, plus the Z.AI Coding Plan, whose key the
 * sandbox sources from the home's `env` file. Model ids name the provider
 * as their first path segment (`zai-coding-plan/glm-5.3`).
 */
export const AUTH_HOME_PROVIDER_IDS = [...SUBSCRIPTION_PROVIDER_IDS, "zai-coding-plan"] as const;
export const authHomeProviderIdSchema = z.enum(AUTH_HOME_PROVIDER_IDS);
export type AuthHomeProviderId = z.infer<typeof authHomeProviderIdSchema>;

/** The provider a model id spends, when a home can carry it; null for every other provider. */
export function authHomeProviderForModel(modelId: string): AuthHomeProviderId | null {
  const parsed = authHomeProviderIdSchema.safeParse(extractProviderAndModel(modelId).provider);
  return parsed.success ? parsed.data : null;
}

const authHomeOwnerUserIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(AUTH_HOME_MAX_OWNERS)
  .refine((ids) => new Set(ids).size === ids.length, "ownerUserIds must be unique");
const authHomeProvidersSchema = z
  .array(authHomeProviderIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, "providers must be unique");
const authHomeKindsEnabledSchema = z
  .array(triggerKindSchema)
  .refine((kinds) => new Set(kinds).size === kinds.length, "kindsEnabled must be unique");

export const authHomeIdSchema = z.string().min(1).max(64);
const nodeNameSchema = z.string().trim().min(1).max(253);

/** One registered home as the registry stores it. */
export const authHomeSchema = z.strictObject({
  id: authHomeIdSchema,
  /** Canonical user ids whose own activity this home serves; [0] is the home owner. */
  ownerUserIds: authHomeOwnerUserIdsSchema,
  pvcName: authHomePvcNameSchema,
  nodeName: nodeNameSchema,
  /** Providers whose credential files the home carries. */
  providers: authHomeProvidersSchema,
  /** Trigger kinds the owner lets run on the home; `prompt` is always a human. */
  kindsEnabled: authHomeKindsEnabledSchema,
  /** When the owner consented to background (non-`prompt`) use; null withholds it. */
  backgroundConsentAt: z.number().int().nonnegative().nullable(),
  maxConcurrent: z.number().int().positive().max(AUTH_HOME_MAX_CONCURRENT_LIMIT),
  /** Offered to the other enrolled people under the `household` policy. */
  shared: z.boolean(),
  /** When the owner consented to sharing; set exactly when `shared` is on. */
  sharingConsentAt: z.number().int().nonnegative().nullable(),
  status: authHomeStatusSchema,
  registeredAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type AuthHome = z.infer<typeof authHomeSchema>;

/** The home owner is the first owner id; the others are the same person's merged identities. */
export function authHomeOwnerUserId(home: Pick<AuthHome, "ownerUserIds">): string {
  return home.ownerUserIds[0]!;
}

/** What an administrator sees of another person's home: everything but the volume name. */
export const authHomeMetadataSchema = authHomeSchema.omit({ pvcName: true });
export type AuthHomeMetadata = z.infer<typeof authHomeMetadataSchema>;

export const authHomeResponseSchema = z.strictObject({ home: authHomeSchema });
export type AuthHomeResponse = z.infer<typeof authHomeResponseSchema>;

export const authHomesResponseSchema = z.strictObject({
  homes: z.array(authHomeMetadataSchema),
});
export type AuthHomesResponse = z.infer<typeof authHomesResponseSchema>;

/**
 * `PUT /me/auth-home`: registers or replaces the caller's own home. The
 * owner is the caller, never a body field. Consent is sent as a boolean and
 * stored as the time it was first given; sending false withdraws it.
 */
export const putAuthHomeRequestSchema = z.strictObject({
  pvcName: authHomePvcNameSchema,
  nodeName: nodeNameSchema,
  providers: authHomeProvidersSchema,
  kindsEnabled: authHomeKindsEnabledSchema.default([...TRIGGER_KINDS]),
  backgroundConsent: z.boolean().default(false),
  maxConcurrent: z
    .number()
    .int()
    .positive()
    .max(AUTH_HOME_MAX_CONCURRENT_LIMIT)
    .default(AUTH_HOME_DEFAULT_MAX_CONCURRENT),
  shared: z.boolean().default(false),
  status: authHomeStatusSchema.default("active"),
});
export type PutAuthHomeRequest = z.infer<typeof putAuthHomeRequestSchema>;

/**
 * Why a turn was refused a home. Every reason is terminal for that turn:
 * there is no key to fall back on.
 */
export const AUTH_HOME_REFUSAL_REASONS = [
  "no_eligible_home",
  "sharing_off",
  "kind_disabled",
  "no_consent",
  "public_repo",
  "auth_home_unavailable",
] as const;
export const authHomeRefusalReasonSchema = z.enum(AUTH_HOME_REFUSAL_REASONS);
export type AuthHomeRefusalReason = z.infer<typeof authHomeRefusalReasonSchema>;

/** The resolver's verdict for one turn: a home to mount, or a refusal with its reason. */
export const authHomeResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("own"),
    homeId: authHomeIdSchema,
    homeOwnerUserId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("shared"),
    homeId: authHomeIdSchema,
    homeOwnerUserId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("refused"),
    reason: authHomeRefusalReasonSchema,
    /** The home that would have served the turn, when one exists (e.g. `sharing_off`). */
    homeId: authHomeIdSchema.optional(),
    homeOwnerUserId: z.string().min(1).optional(),
  }),
]);
export type AuthHomeResolution = z.infer<typeof authHomeResolutionSchema>;

/** The user-facing refusal, one sentence per reason, never mentioning a key. */
export function authHomeRefusalMessage(
  reason: AuthHomeRefusalReason,
  provider: AuthHomeProviderId | SubscriptionProviderId | string
): string {
  switch (reason) {
    case "no_eligible_home":
      return (
        `no eligible subscription home for ${provider}: enrol one under Settings > Subscription homes, ` +
        "or ask an enrolled colleague to share theirs"
      );
    case "sharing_off":
      return `no eligible subscription home for ${provider}: the only home carrying it is not shared with you`;
    case "kind_disabled":
      return `the subscription home for ${provider} does not run this kind of session`;
    case "no_consent":
      return `the subscription home for ${provider} has not consented to background use`;
    case "public_repo":
      return `the subscription home for ${provider} serves private repositories only`;
    case "auth_home_unavailable":
      return `the subscription home for ${provider} is not available on its node right now`;
  }
}

/** Error code of a 4xx that refuses to store a subscription token in the control plane. */
export const SUBSCRIPTION_TOKEN_NOT_STORABLE = "subscription_token_not_storable" as const;
/** Providers whose connect routes refuse: their subscription credential lives only in an auth home. */
export const SUBSCRIPTION_TOKEN_PROVIDERS: readonly SubscriptionProviderId[] = ["anthropic"];
/** Error code of the 403 a turn receives when no home may serve it. */
export const NO_ELIGIBLE_HOME = "no_eligible_home" as const;
