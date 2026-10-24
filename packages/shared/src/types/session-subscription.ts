import { z } from "zod";
import {
  AUTH_HOME_PROVIDER_IDS,
  authHomeProviderIdSchema,
  type AuthHomeProviderId,
} from "./auth-homes";
import { RUNNABILITY_PAYERS } from "./runnability";
import { subscriptionSlotSchema } from "./sandbox-events";

/** The product a person subscribes to, per provider a session can spend. */
export const SESSION_SUBSCRIPTION_PRODUCT_NAMES = {
  anthropic: "Claude",
  openai: "ChatGPT",
  xai: "SuperGrok",
  "zai-coding-plan": "Z.AI Coding Plan",
  antigravity: "Antigravity",
} as const satisfies Readonly<Record<AuthHomeProviderId, string>>;

/**
 * Whose subscription a session spends for one provider, relative to the viewer.
 * `you`: the viewer's own home or account. `colleague`: another person's home or
 * account. `workspace`: an installation API key, secret or legacy credential, held by no one.
 */
export const SESSION_SUBSCRIPTION_HOLDERS = ["you", "colleague", "workspace"] as const;

/** Bounds the per-session slot list; a pool has a handful of slots. */
export const MAX_SESSION_SUBSCRIPTION_SLOTS = 32;

/** One subscription-home slot the session's settled turns spent, from the usage ledger. */
export const sessionSubscriptionSlotSchema = z.strictObject({
  /** The slot's name in the home's pool (`claude-3`), or `default` for a single token. */
  slot: subscriptionSlotSchema,
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  /** When the slot's latest turn settled (epoch ms). */
  lastUsedAt: z.number(),
});
export type SessionSubscriptionSlot = z.infer<typeof sessionSubscriptionSlotSchema>;

export const sessionSubscriptionSchema = z.strictObject({
  provider: authHomeProviderIdSchema,
  authMode: z.enum(["provider_account", "api_key", "legacy_scoped_oauth", "auth_home"]),
  holder: z.enum(SESSION_SUBSCRIPTION_HOLDERS),
  /** True when a colleague's subscription was lent through household sharing. */
  shared: z.boolean(),
  /**
   * The holder, disclosed only to the holder, the session's starter and workspace
   * administrators; other viewers learn that a colleague's subscription is used, not whose.
   */
  holderUserId: z.string().nullable(),
  holderDisplayName: z.string().nullable(),
  /**
   * Who actually pays on the session's harness and model (`assessRunnability`):
   * `none` when the harness cannot use this credential, so it pays for nothing
   * (OpenCode on a Claude home) even though it is bound to the session.
   */
  payer: z.enum(RUNNABILITY_PAYERS),
  /** The provider account's label; null for homes, API keys and undisclosed holders. */
  accountDisplayName: z.string().nullable(),
  /**
   * The home slots the session's turns spent, most recently used first. Only a
   * Claude home (claude/pool) and a Codex home with a login pool (codex-pool) report
   * them; empty for every other entry and for turns that settled before the sandbox
   * reported slots.
   */
  slots: z.array(sessionSubscriptionSlotSchema).max(MAX_SESSION_SUBSCRIPTION_SLOTS),
});
export type SessionSubscription = z.infer<typeof sessionSubscriptionSchema>;

export const sessionSubscriptionResponseSchema = z.strictObject({
  subscriptions: z.array(sessionSubscriptionSchema).max(AUTH_HOME_PROVIDER_IDS.length),
});
export type SessionSubscriptionResponse = z.infer<typeof sessionSubscriptionResponseSchema>;
