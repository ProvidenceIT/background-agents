import { z } from "zod";
import {
  AUTH_HOME_PROVIDER_IDS,
  authHomeProviderIdSchema,
  type AuthHomeProviderId,
} from "./auth-homes";

/** The product a person subscribes to, per provider a session can spend. */
export const SESSION_SUBSCRIPTION_PRODUCT_NAMES = {
  anthropic: "Claude",
  openai: "ChatGPT",
  xai: "SuperGrok",
  "zai-coding-plan": "Z.AI Coding Plan",
} as const satisfies Readonly<Record<AuthHomeProviderId, string>>;

/**
 * Whose subscription a session spends for one provider, relative to the viewer.
 * `you`: the viewer's own home or account. `colleague`: another person's home or
 * account. `workspace`: an installation API key, secret or legacy credential, held by no one.
 */
export const SESSION_SUBSCRIPTION_HOLDERS = ["you", "colleague", "workspace"] as const;

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
  /** The provider account's label; null for homes, API keys and undisclosed holders. */
  accountDisplayName: z.string().nullable(),
});
export type SessionSubscription = z.infer<typeof sessionSubscriptionSchema>;

export const sessionSubscriptionResponseSchema = z.strictObject({
  subscriptions: z.array(sessionSubscriptionSchema).max(AUTH_HOME_PROVIDER_IDS.length),
});
export type SessionSubscriptionResponse = z.infer<typeof sessionSubscriptionResponseSchema>;
