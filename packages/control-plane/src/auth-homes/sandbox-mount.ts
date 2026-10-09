import { authHomeOwnerUserId, type AuthHome } from "@open-inspect/shared/types/auth-homes";
import type { SqlDatabase } from "../db/sql-database";
import { AuthHomeUnavailableError, type SandboxAuthHome } from "../sandbox/provider";
import { UserAuthHomeStore } from "./store";

/**
 * What a sandbox launch mounts for a session: the home the resolver bound to
 * it (`sessions.auth_home_id`), named by its claim. Session creation (including
 * child spawns and scheduled runs) is the only writer of that binding; later
 * turns are gated against it (enforceAuthHomeTurn) and refused rather than
 * rebound. A launch only reads it, so a create and a resume mount the bound
 * home, and a resume reaches here only after the acting turn passed the gate.
 */
export interface SessionAuthHomeLookup {
  /**
   * The bound home, or undefined when the session has none. Throws
   * AuthHomeUnavailableError when the binding names a home that is gone or
   * disabled: a launch then refuses rather than start without a credential.
   */
  getForSession(sessionId: string): Promise<SandboxAuthHome | undefined>;
}

function toSandboxAuthHome(home: AuthHome): SandboxAuthHome {
  return {
    pvcName: home.pvcName,
    ownerUserId: authHomeOwnerUserId(home),
    providers: [...home.providers],
  };
}

export function createSessionAuthHomeLookup(db: SqlDatabase): SessionAuthHomeLookup {
  const homes = new UserAuthHomeStore(db);
  return {
    async getForSession(sessionId) {
      const row = await db
        .prepare("SELECT auth_home_id FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ auth_home_id: string | null }>();
      const homeId = row?.auth_home_id;
      if (!homeId) return undefined;
      const home = await homes.getById(homeId);
      if (!home) {
        throw new AuthHomeUnavailableError(`Subscription home ${homeId} is no longer registered`);
      }
      if (home.status !== "active") {
        throw new AuthHomeUnavailableError(`Subscription home ${homeId} is ${home.status}`);
      }
      return toSandboxAuthHome(home);
    },
  };
}
