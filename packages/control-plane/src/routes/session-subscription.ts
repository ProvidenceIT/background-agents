import type { AuthHome } from "@open-inspect/shared/types/auth-homes";
import type {
  SessionSubscription,
  SessionSubscriptionResponse,
} from "@open-inspect/shared/types/provider-accounts";
import { UserAuthHomeStore } from "../auth-homes/store";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { SessionIndexStore } from "../db/session-index";
import { UserStore } from "../db/user-store";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { Env } from "../types";
import { error } from "./shared";
import type { SessionRouteContext } from "./session-route";

interface Holder {
  /** Every id that names the holder; [0] is canonical (a home lists merged identities). */
  userIds: readonly string[];
  accountDisplayName: string | null;
}

async function holderFor(
  auth: SessionModelProviderAuthInput,
  home: AuthHome | null,
  accounts: ModelProviderAccountStore
): Promise<Holder | null> {
  if (auth.authMode === "auth_home") {
    return home ? { userIds: home.ownerUserIds, accountDisplayName: null } : null;
  }
  if (auth.authMode === "provider_account") {
    const account = await accounts.getById(auth.providerAccountId);
    return account?.ownerUserId
      ? { userIds: [account.ownerUserId], accountDisplayName: account.displayName }
      : null;
  }
  return null;
}

/**
 * Which Claude/Codex/Grok subscription the session spends per provider. Whose it
 * is is stated relative to the viewer; the holder is named only to the holder, the
 * session's starter and workspace administrators, as with Codex seat usage.
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

  const providerAuth = await sessions.getProviderAuth(row.id);
  const home = row.authHomeId ? await new UserAuthHomeStore(ctx.db).getById(row.authHomeId) : null;
  const accounts = new ModelProviderAccountStore(ctx.db);
  const holders = await Promise.all(providerAuth.map((auth) => holderFor(auth, home, accounts)));

  const disclosed = (holder: Holder | null): holder is Holder =>
    holder !== null &&
    (viewerIsAdmin ||
      viewerStartedSession ||
      (viewerId !== null && holder.userIds.includes(viewerId)));
  const names = new Map(
    (
      await new UserStore(ctx.db).getUsersByIds(
        holders.filter(disclosed).map((holder) => holder.userIds[0])
      )
    ).map((user) => [user.id, user.displayName])
  );

  const subscriptions = providerAuth.map((auth, index): SessionSubscription => {
    const holder = holders[index];
    const ownedByViewer = viewerId !== null && holder?.userIds.includes(viewerId) === true;
    const personal = auth.authMode === "auth_home" || auth.authMode === "provider_account";
    const holderUserId = disclosed(holder) ? holder.userIds[0] : null;
    return {
      provider: auth.provider,
      authMode: auth.authMode,
      holder: ownedByViewer ? "you" : personal ? "colleague" : "workspace",
      shared: auth.selectionSource === "auth_home_shared",
      holderUserId,
      holderDisplayName: holderUserId ? (names.get(holderUserId) ?? null) : null,
      accountDisplayName: disclosed(holder) ? holder.accountDisplayName : null,
    };
  });
  return Response.json({ subscriptions } satisfies SessionSubscriptionResponse);
}
