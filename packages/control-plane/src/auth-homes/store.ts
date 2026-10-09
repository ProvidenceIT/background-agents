import {
  authHomeSchema,
  authHomeOwnerUserId,
  DEFAULT_SUBSCRIPTION_SHARING_POLICY,
  subscriptionSharingPolicySchema,
  subscriptionSharingSchema,
  TRIGGER_KINDS,
  type AuthHome,
  type AuthHomeProviderId,
  type AuthHomeStatus,
  type SubscriptionSharing,
  type SubscriptionSharingPolicy,
  type TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { LIKE_ESCAPE_CLAUSE, likeContains } from "../db/like-pattern";
import type { SqlDatabase } from "../db/sql-database";

export { authHomeOwnerUserId };

/**
 * The subscription auth-home registry.
 *
 * A row says whose home a claim is, which providers it carries and what its
 * owner consents to. It never holds a credential: the provider's CLI reads
 * that from the mounted volume. The resolver (a later slice) reads this
 * registry on every turn; these stores are the only writers.
 */

export class AuthHomeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthHomeValidationError";
  }
}

const homeRowSchema = z.object({
  id: z.string(),
  owner_user_ids: z.string(),
  pvc_name: z.string(),
  node_name: z.string(),
  providers: z.string(),
  kinds_enabled: z.string(),
  background_consent_at: z.number().nullable(),
  max_concurrent: z.number(),
  shared: z.number(),
  sharing_consent_at: z.number().nullable(),
  status: z.string(),
  registered_at: z.number(),
  updated_at: z.number(),
});

function parseJsonArray(value: string, column: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Malformed user_auth_homes.${column}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Malformed user_auth_homes.${column}`);
  return parsed;
}

function toHome(raw: unknown): AuthHome {
  const row = homeRowSchema.parse(raw);
  return authHomeSchema.parse({
    id: row.id,
    ownerUserIds: parseJsonArray(row.owner_user_ids, "owner_user_ids"),
    pvcName: row.pvc_name,
    nodeName: row.node_name,
    providers: parseJsonArray(row.providers, "providers"),
    kindsEnabled: parseJsonArray(row.kinds_enabled, "kinds_enabled"),
    backgroundConsentAt: row.background_consent_at,
    maxConcurrent: row.max_concurrent,
    shared: row.shared === 1,
    sharingConsentAt: row.sharing_consent_at,
    status: row.status,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  });
}

const HOME_COLUMNS = `id, owner_user_ids, pvc_name, node_name, providers, kinds_enabled,
  background_consent_at, max_concurrent, shared, sharing_consent_at, status, registered_at,
  updated_at`;

/** A new registration. Consent fields are the moments consent was given, or null. */
export interface RegisterAuthHomeInput {
  /** Generated when omitted. */
  id?: string;
  ownerUserIds: readonly string[];
  pvcName: string;
  nodeName: string;
  providers: readonly AuthHomeProviderId[];
  /** Every kind when omitted. */
  kindsEnabled?: readonly TriggerKind[];
  backgroundConsentAt?: number | null;
  maxConcurrent?: number;
  shared?: boolean;
  sharingConsentAt?: number | null;
  status?: AuthHomeStatus;
  now?: number;
}

/** Fields an owner may change after registration; the owner ids are fixed. */
export interface UpdateAuthHomeInput {
  pvcName?: string;
  nodeName?: string;
  providers?: readonly AuthHomeProviderId[];
  kindsEnabled?: readonly TriggerKind[];
  backgroundConsentAt?: number | null;
  maxConcurrent?: number;
  shared?: boolean;
  sharingConsentAt?: number | null;
  status?: AuthHomeStatus;
  now?: number;
}

export class UserAuthHomeStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Insert a home; the returned row is what every reader will see. */
  async register(input: RegisterAuthHomeInput): Promise<AuthHome> {
    const now = input.now ?? Date.now();
    const home = this.validate({
      id: input.id ?? `ah_${generateId()}`,
      ownerUserIds: [...input.ownerUserIds],
      pvcName: input.pvcName,
      nodeName: input.nodeName,
      providers: [...input.providers],
      kindsEnabled: [...(input.kindsEnabled ?? TRIGGER_KINDS)],
      backgroundConsentAt: input.backgroundConsentAt ?? null,
      maxConcurrent: input.maxConcurrent ?? 3,
      shared: input.shared ?? false,
      sharingConsentAt: input.sharingConsentAt ?? null,
      status: input.status ?? "active",
      registeredAt: now,
      updatedAt: now,
    });
    await this.db
      .prepare(
        `INSERT INTO user_auth_homes (${HOME_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        home.id,
        JSON.stringify(home.ownerUserIds),
        home.pvcName,
        home.nodeName,
        JSON.stringify(home.providers),
        JSON.stringify(home.kindsEnabled),
        home.backgroundConsentAt,
        home.maxConcurrent,
        home.shared ? 1 : 0,
        home.sharingConsentAt,
        home.status,
        home.registeredAt,
        home.updatedAt
      )
      .run();
    return home;
  }

  /** Replace the mutable fields of a home; null when no such home. */
  async update(id: string, patch: UpdateAuthHomeInput): Promise<AuthHome | null> {
    const current = await this.getById(id);
    if (!current) return null;
    const now = patch.now ?? Date.now();
    const next = this.validate({
      ...current,
      pvcName: patch.pvcName ?? current.pvcName,
      nodeName: patch.nodeName ?? current.nodeName,
      providers: patch.providers ? [...patch.providers] : current.providers,
      kindsEnabled: patch.kindsEnabled ? [...patch.kindsEnabled] : current.kindsEnabled,
      backgroundConsentAt:
        patch.backgroundConsentAt === undefined
          ? current.backgroundConsentAt
          : patch.backgroundConsentAt,
      maxConcurrent: patch.maxConcurrent ?? current.maxConcurrent,
      shared: patch.shared ?? current.shared,
      sharingConsentAt:
        patch.sharingConsentAt === undefined ? current.sharingConsentAt : patch.sharingConsentAt,
      status: patch.status ?? current.status,
      updatedAt: now,
    });
    const result = await this.db
      .prepare(
        `UPDATE user_auth_homes
         SET pvc_name = ?, node_name = ?, providers = ?, kinds_enabled = ?,
             background_consent_at = ?, max_concurrent = ?, shared = ?, sharing_consent_at = ?,
             status = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        next.pvcName,
        next.nodeName,
        JSON.stringify(next.providers),
        JSON.stringify(next.kindsEnabled),
        next.backgroundConsentAt,
        next.maxConcurrent,
        next.shared ? 1 : 0,
        next.sharingConsentAt,
        next.status,
        next.updatedAt,
        id
      )
      .run();
    return result.meta.changes === 1 ? next : null;
  }

  async getById(id: string): Promise<AuthHome | null> {
    const row = await this.db
      .prepare(`SELECT ${HOME_COLUMNS} FROM user_auth_homes WHERE id = ?`)
      .bind(id)
      .first();
    return row ? toHome(row) : null;
  }

  /** Every home, oldest registration first. */
  async list(): Promise<AuthHome[]> {
    const rows = await this.db
      .prepare(`SELECT ${HOME_COLUMNS} FROM user_auth_homes ORDER BY registered_at, id`)
      .all();
    return rows.results.map(toHome);
  }

  /**
   * The homes whose owner ids include `userId`, oldest first. The LIKE on the
   * JSON text is a prefilter; the parsed array decides, so an id that is a
   * substring of another never matches.
   */
  async listForUser(userId: string): Promise<AuthHome[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${HOME_COLUMNS} FROM user_auth_homes
         WHERE owner_user_ids LIKE ? ${LIKE_ESCAPE_CLAUSE}
         ORDER BY registered_at, id`
      )
      .bind(likeContains(JSON.stringify(userId)))
      .all();
    return rows.results.map(toHome).filter((home) => home.ownerUserIds.includes(userId));
  }

  /** The caller's own home: the oldest one that names them as an owner. */
  async findOwnedBy(userId: string): Promise<AuthHome | null> {
    const homes = await this.listForUser(userId);
    return homes[0] ?? null;
  }

  /** Active homes offered to the household, oldest first; the resolver's rule 2 candidates. */
  async listShared(): Promise<AuthHome[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${HOME_COLUMNS} FROM user_auth_homes
         WHERE status = 'active' AND shared = 1
         ORDER BY registered_at, id`
      )
      .all();
    return rows.results.map(toHome);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM user_auth_homes WHERE id = ?").bind(id).run();
    return result.meta.changes > 0;
  }

  private validate(candidate: AuthHome): AuthHome {
    const parsed = authHomeSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.map(String).join(".");
      throw new AuthHomeValidationError(
        path ? `${path}: ${issue?.message}` : (issue?.message ?? "Invalid auth home")
      );
    }
    if (parsed.data.shared && parsed.data.sharingConsentAt === null) {
      throw new AuthHomeValidationError("shared: sharing requires the owner's consent");
    }
    return parsed.data;
  }
}

interface SharingRow {
  policy: string;
  updated_by: string | null;
  updated_at: number;
}

/** The single-row workspace setting; an absent row is the default policy. */
export class SubscriptionSharingStore {
  constructor(private readonly db: SqlDatabase) {}

  async getSnapshot(): Promise<SubscriptionSharing> {
    const row = await this.db
      .prepare(
        "SELECT policy, updated_by, updated_at FROM subscription_sharing WHERE id = 'global'"
      )
      .first<SharingRow>();
    if (!row) {
      return { policy: DEFAULT_SUBSCRIPTION_SHARING_POLICY, updatedBy: null, updatedAt: null };
    }
    const policy = subscriptionSharingPolicySchema.safeParse(row.policy);
    return subscriptionSharingSchema.parse({
      policy: policy.success ? policy.data : DEFAULT_SUBSCRIPTION_SHARING_POLICY,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    });
  }

  async get(): Promise<SubscriptionSharingPolicy> {
    return (await this.getSnapshot()).policy;
  }

  /** Write the policy; the previous policy comes back with it for the audit row. */
  async set(
    policy: SubscriptionSharingPolicy,
    byUserId: string,
    now = Date.now()
  ): Promise<{ previous: SubscriptionSharingPolicy; current: SubscriptionSharing }> {
    const previous = await this.get();
    await this.db
      .prepare(
        `INSERT INTO subscription_sharing (id, policy, updated_by, updated_at)
         VALUES ('global', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           policy = excluded.policy,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .bind(policy, byUserId, now)
      .run();
    return { previous, current: { policy, updatedBy: byUserId, updatedAt: now } };
  }
}
