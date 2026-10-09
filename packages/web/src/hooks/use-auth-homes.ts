import useSWR from "swr";
import { z } from "zod";
import {
  authHomeResponseSchema,
  authHomesResponseSchema,
  subscriptionSharingSchema,
  type AuthHome,
  type AuthHomeMetadata,
  type PutAuthHomeRequest,
  type SubscriptionSharing,
  type SubscriptionSharingPolicy,
} from "@open-inspect/shared/types/auth-homes";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const OWN_HOME_KEY = "/api/me/auth-home";
const HOMES_KEY = "/api/auth-homes";
const SHARING_KEY = "/api/subscription-sharing";

const errorBodySchema = z.object({ error: z.string() });

/** A failed subscription-home request, with the control plane's message when it gave one. */
export class AuthHomeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AuthHomeRequestError";
  }
}

async function request(
  path: BrowserApiPath,
  init?: { method: "PUT" | "DELETE"; body?: unknown }
): Promise<Response> {
  const response = await browserApiFetch(path, {
    method: init?.method,
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.ok || (response.status === 404 && path === OWN_HOME_KEY && !init)) {
    return response;
  }
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => null));
  throw new AuthHomeRequestError(
    parsed.success ? parsed.data.error : "Subscription home request failed",
    response.status
  );
}

/** The caller's own home, or null when none is registered for them (the route's 404). */
async function fetchOwnHome(): Promise<AuthHome | null> {
  const response = await request(OWN_HOME_KEY);
  if (response.status === 404) return null;
  return authHomeResponseSchema.parse(await response.json()).home;
}

async function fetchHomes(): Promise<AuthHomeMetadata[]> {
  return authHomesResponseSchema.parse(await (await request(HOMES_KEY)).json()).homes;
}

async function fetchSharing(): Promise<SubscriptionSharing> {
  return subscriptionSharingSchema.parse(await (await request(SHARING_KEY)).json());
}

export function useOwnAuthHome() {
  const { data, error, isLoading, mutate } = useSWR(OWN_HOME_KEY, fetchOwnHome);
  return { home: data ?? null, loading: isLoading, error, mutate };
}

/** Every enrolled home as metadata, for viewers holding auth_homes.read_all. */
export function useEnrolledAuthHomes(enabled: boolean) {
  const { data, error, isLoading } = useSWR(enabled ? HOMES_KEY : null, fetchHomes);
  return { homes: data ?? [], loading: isLoading, error };
}

export function useSubscriptionSharing() {
  const { data, error, isLoading, mutate } = useSWR(SHARING_KEY, fetchSharing);
  return { sharing: data ?? null, loading: isLoading, error, mutate };
}

/** Register or replace the caller's home; the owner is the signed-in user, never a field. */
export async function putOwnAuthHome(body: PutAuthHomeRequest): Promise<AuthHome> {
  const response = await request(OWN_HOME_KEY, { method: "PUT", body });
  return authHomeResponseSchema.parse(await response.json()).home;
}

export async function deleteOwnAuthHome(): Promise<void> {
  await request(OWN_HOME_KEY, { method: "DELETE" });
}

export async function putSubscriptionSharing(
  policy: SubscriptionSharingPolicy
): Promise<SubscriptionSharing> {
  const response = await request(SHARING_KEY, { method: "PUT", body: { policy } });
  return subscriptionSharingSchema.parse(await response.json());
}

/** The PUT body that keeps every field of `home` as it is, before a change is applied. */
export function authHomeRequestFrom(home: AuthHome): PutAuthHomeRequest {
  return {
    pvcName: home.pvcName,
    nodeName: home.nodeName,
    providers: [...home.providers],
    kindsEnabled: [...home.kindsEnabled],
    backgroundConsent: home.backgroundConsentAt !== null,
    maxConcurrent: home.maxConcurrent,
    shared: home.shared,
    status: home.status,
  };
}
