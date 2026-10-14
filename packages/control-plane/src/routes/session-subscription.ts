import type { AuthHome, AuthHomeProviderId } from "@open-inspect/shared/types/auth-homes";
import type {
  SessionSubscription,
  SessionSubscriptionResponse,
} from "@open-inspect/shared/types/session-subscription";
import { UserAuthHomeStore } from "../auth-homes/store";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { SessionIndexStore } from "../db/session-index";
import { UsageLedgerStore } from "../db/usage-ledger";
import { UserStore } from "../db/user-store";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { Env } from "../types";
import { error } from "./shared";
import type { SessionRouteContext } from "./session-route";

/** Only the Claude harness reports which home slot a turn spent. */
const SLOT_PROVIDER = "anthropic" satisfies AuthHomeProviderId;

/** Z.AI has no provider-auth row: only a home carries it, else workspace secrets do. */
const ZAI_PROVIDER = "zai-coding-plan" satisfies AuthHomeProviderId;

interface Holder {
  /** Every id that names the holder; [0] is canonical (a home lists merged identities). */
  userIds: readonly string[];
  accountDisplayName: string | null;
}

interface SpentSubscription {
  provider: AuthHomeProviderId;
  authMode: SessionSubscription["authMode"];
  shared: boolean;
  holder: Holder | null;
}

function homeHolder(home: AuthHome): Holder {
  return { userIds: home.ownerUserIds, accountDisplayName: null };
}

async function spentFromProviderAuth(
  auth: SessionModelProviderAuthInput,
  home: AuthHome | null,
  accounts: ModelProviderAccountStore
): Promise<SpentSubscription> {
  const spent = {
    provider: auth.provider,
    authMode: auth.authMode,
    shared: auth.selectionSource === "auth_home_shared",
  };
  if (auth.authMode === "auth_home") {
    return { ...spent, holder: home ? homeHolder(home) : null };
  }
  if (auth.authMode === "provider_account") {
    const account = await accounts.getById(auth.providerAccountId);
    return {
      ...spent,
      holder: account?.ownerUserId
        ? { userIds: [account.ownerUserId], accountDisplayName: account.displayName }
        : null,
    };
  }
  return { ...spent, holder: null };
}

/**
 * Which Claude/Codex/Grok/Z.AI subscription the session spends per provider, and for a
 * Claude home which pool slots its turns spent. Whose it is is stated relative to the
 * viewer; the holder is named only to the holder, the session's starter and workspace
 * administrators, as with Codex seat usage.
 */
export async function handleSessionSubscription(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessions = new SessionIndexStore(ctx.db);
  const row = ctx.sessionAdmission?.row ?? (await sessions.get(params.id));
  if (!row) return error("Session not found", 404);

  const viewerId = ctx.authorization?.userId ?? null;
  const viewerIsAdmin = ctx.authorization?.permissions.includes("auth_homes.read_all") ?? false;
  const viewerStartedSession =
    viewerId !== null && (viewerId === row.userId || viewerId === row.triggerActorUserId);

  const home = row.authHomeId ? await new UserAuthHomeStore(ctx.db).getById(row.authHomeId) : null;
  const accounts = new ModelProviderAccountStore(ctx.db);
  const slots = await new UsageLedgerStore(ctx.db).slotsForSession(row.id);
  const spent = await Promise.all(
    (await sessions.getProviderAuth(row.id)).map((auth) =>
      spentFromProviderAuth(auth, home, accounts)
    )
  );
  spent.push(
    home?.providers.includes(ZAI_PROVIDER)
      ? {
          provider: ZAI_PROVIDER,
          authMode: "auth_home",
          shared: row.authHomeSelection === "shared",
          holder: homeHolder(home),
        }
      : { provider: ZAI_PROVIDER, authMode: "api_key", shared: false, holder: null }
  );

  const disclosed = (holder: Holder | null): holder is Holder =>
    holder !== null &&
    (viewerIsAdmin ||
      viewerStartedSession ||
      (viewerId !== null && holder.userIds.includes(viewerId)));
  const names = new Map(
    (
      await new UserStore(ctx.db).getUsersByIds(
        spent.flatMap(({ holder }) => (disclosed(holder) ? [holder.userIds[0]] : []))
      )
    ).map((user) => [user.id, user.displayName])
  );

  const subscriptions = spent.map(({ provider, authMode, shared, holder }): SessionSubscription => {
    const ownedByViewer = viewerId !== null && holder?.userIds.includes(viewerId) === true;
    const personal = authMode === "auth_home" || authMode === "provider_account";
    const holderUserId = disclosed(holder) ? holder.userIds[0] : null;
    return {
      provider,
      authMode,
      holder: ownedByViewer ? "you" : personal ? "colleague" : "workspace",
      shared,
      holderUserId,
      holderDisplayName: holderUserId ? (names.get(holderUserId) ?? null) : null,
      accountDisplayName: disclosed(holder) ? holder.accountDisplayName : null,
      // A slot name says which of the holder's pooled accounts ran, not whose it is.
      slots: provider === SLOT_PROVIDER && authMode === "auth_home" ? slots : [],
    };
  });
  return Response.json({ subscriptions } satisfies SessionSubscriptionResponse);
}
