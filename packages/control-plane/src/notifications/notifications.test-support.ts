/**
 * Test-only fixtures for the notification module's tests. The caller opens
 * the migrated database (worker code may not import the Node adapters).
 */

import { vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";

export const OWNER = "user-owner";
export const OWNER_OID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

export function silentLogger(): Logger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  } as unknown as Logger;
  return log;
}

/** The owner, with a Microsoft identity unless `oid` is null. */
export async function seedOwner(db: SqlDatabase, oid: string | null = OWNER_OID): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
    .bind(OWNER, "Owner")
    .run();
  if (oid !== null) {
    await db
      .prepare(
        `INSERT INTO user_identities (id, user_id, provider, provider_user_id, created_at)
         VALUES ('i-owner', ?, 'microsoft', ?, 1)`
      )
      .bind(OWNER, oid)
      .run();
  }
}

/** One session index row owned by `OWNER`. */
export async function seedSession(
  db: SqlDatabase,
  sessionId: string,
  fields: { userId?: string | null; externalRef?: { service: string; ref: string } } = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, user_id, visibility,
         external_ref_service, external_ref, created_at, updated_at)
       VALUES (?, 'Acme client secret plan', 'acme', 'widgets', 'anthropic/claude-sonnet-4-6',
         'completed', ?, 'private', ?, ?, 1, 1)`
    )
    .bind(
      sessionId,
      fields.userId === undefined ? OWNER : fields.userId,
      fields.externalRef?.service ?? null,
      fields.externalRef?.ref ?? null
    )
    .run();
}
