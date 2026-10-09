import type { AuthHome, SubscriptionSharingPolicy } from "@open-inspect/shared/types/auth-homes";
import { z } from "zod";
import { bindAuthHomeAuditEvent } from "../auth-homes/audit";
import { SubscriptionSharingStore, UserAuthHomeStore } from "../auth-homes/store";
import type { SqlDatabase } from "../db/sql-database";

/**
 * `SUBSCRIPTION_SECRET_OWNERS`: secrets that are a person's own subscription
 * (a Z.AI Coding Plan key kept as a workspace secret, for example), each with
 * the canonical user ids of the person who owns it (their merged identities).
 * A listed secret reaches a sandbox when the session's trigger actor owns
 * it, for every trigger kind. Anyone else gets it only as the owner's home
 * would be shared: under the `household` policy, when the actor is enrolled
 * (owns an active home) and the key's owner has an active home switched to
 * `shared`. Every such use is reported so it can be audited. Unlisted
 * secrets are unaffected.
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

/** The sharing state an owner-tagged secret follows: the policy and every home. */
export interface SubscriptionSecretSharing {
  policy: SubscriptionSharingPolicy;
  homes: readonly AuthHome[];
}

/** An owner-tagged secret that reached someone else through its owner's shared home. */
export interface SharedSubscriptionSecret {
  key: string;
  homeId: string;
  homeOwnerUserId: string;
}

/** The home through which `actorUserId` may spend a secret owned by `keyOwners`, if any. */
function sharedHomeFor(
  keyOwners: ReadonlySet<string>,
  actorUserId: string,
  sharing: SubscriptionSecretSharing
): AuthHome | null {
  if (sharing.policy !== "household") return null;
  const active = sharing.homes.filter((home) => home.status === "active");
  const enrolled = active.some((home) => home.ownerUserIds.includes(actorUserId));
  if (!enrolled) return null;
  return (
    active.find((home) => home.shared && home.ownerUserIds.some((id) => keyOwners.has(id))) ?? null
  );
}

/**
 * `secrets` without the owner-tagged keys `actorUserId` may not spend, the
 * names it removed (never the values), and the keys it kept only because
 * their owner's home is shared with the actor. Without `sharing`, only an
 * owner keeps a key.
 */
export function withoutForeignSubscriptionSecrets(
  secrets: Record<string, string>,
  owners: SubscriptionSecretOwners,
  actorUserId: string | null,
  sharing?: SubscriptionSecretSharing
): { secrets: Record<string, string>; stripped: string[]; shared: SharedSubscriptionSecret[] } {
  const stripped: string[] = [];
  const shared: SharedSubscriptionSecret[] = [];
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    const keyOwners = owners.get(key);
    if (keyOwners && !(actorUserId && keyOwners.has(actorUserId))) {
      const home = actorUserId && sharing ? sharedHomeFor(keyOwners, actorUserId, sharing) : null;
      if (!home) {
        stripped.push(key);
        continue;
      }
      shared.push({ key, homeId: home.id, homeOwnerUserId: home.ownerUserIds[0]! });
    }
    kept[key] = value;
  }
  return { secrets: kept, stripped, shared };
}

/** Where the resolver reads the sharing state and records a shared use. */
export interface SubscriptionSecretSharingPort {
  load(): Promise<SubscriptionSecretSharing>;
  /** One `credential.subscription_secret_shared` row per key: names and homes, never values. */
  recordShared(input: {
    sessionId: string;
    actorUserId: string;
    uses: readonly SharedSubscriptionSecret[];
  }): Promise<void>;
}

export function createSubscriptionSecretSharing(db: SqlDatabase): SubscriptionSecretSharingPort {
  return {
    async load() {
      const [policy, homes] = await Promise.all([
        new SubscriptionSharingStore(db).get(),
        new UserAuthHomeStore(db).list(),
      ]);
      return { policy, homes };
    },
    async recordShared({ sessionId, actorUserId, uses }) {
      if (uses.length === 0) return;
      const requestId = crypto.randomUUID();
      await db.batch(
        uses.map((use) =>
          bindAuthHomeAuditEvent(db, {
            requestId,
            actorUserId,
            action: "credential.subscription_secret_shared",
            resourceType: "session",
            resourceId: sessionId,
            targetUserId: use.homeOwnerUserId,
            metadata: {
              secret: use.key,
              home_id: use.homeId,
              home_owner: use.homeOwnerUserId,
              actor: actorUserId,
              selection: "shared",
            },
          })
        )
      );
    },
  };
}
