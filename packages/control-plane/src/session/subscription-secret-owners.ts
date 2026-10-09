import { z } from "zod";

/**
 * `SUBSCRIPTION_SECRET_OWNERS`: secrets that are a person's own subscription
 * (a Z.AI Coding Plan key kept as a workspace secret, for example), each with
 * the canonical user ids whose activity may spend it. A listed secret reaches
 * a sandbox only when the session's trigger actor is one of its owners, for
 * every trigger kind; unlisted secrets are unaffected.
 *
 * The interim form of an auth home's `env` file: once the key lives in the
 * home, the resolver decides instead and the entry is removed.
 */
const subscriptionSecretOwnersSchema = z.record(z.string().min(1), z.array(z.string().min(1)));

export type SubscriptionSecretOwners = ReadonlyMap<string, ReadonlySet<string>>;

/** Parse the variable; unset or empty means no secret is owner-tagged. Throws on malformed JSON. */
export function parseSubscriptionSecretOwners(raw: string | undefined): SubscriptionSecretOwners {
  if (!raw?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SUBSCRIPTION_SECRET_OWNERS must be a JSON object of secret name to user ids");
  }
  const result = subscriptionSecretOwnersSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("SUBSCRIPTION_SECRET_OWNERS must be a JSON object of secret name to user ids");
  }
  return new Map(Object.entries(result.data).map(([key, owners]) => [key, new Set(owners)]));
}

/**
 * `secrets` without the owner-tagged keys `actorUserId` does not own, and the
 * names it removed (never the values).
 */
export function withoutForeignSubscriptionSecrets(
  secrets: Record<string, string>,
  owners: SubscriptionSecretOwners,
  actorUserId: string | null
): { secrets: Record<string, string>; stripped: string[] } {
  const stripped: string[] = [];
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    const keyOwners = owners.get(key);
    if (keyOwners && !(actorUserId && keyOwners.has(actorUserId))) {
      stripped.push(key);
      continue;
    }
    kept[key] = value;
  }
  return { secrets: kept, stripped };
}
