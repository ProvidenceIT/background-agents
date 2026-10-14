"use client";

import {
  sessionSubscriptionResponseSchema,
  type SessionSubscription,
} from "@open-inspect/shared/types/session-subscription";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import useSWR from "swr";

/** The subscription the session spends for its current model's provider, if recorded. */
export function useSessionSubscription(
  sessionId: string | undefined,
  model: string | undefined
): SessionSubscription | null {
  const { data } = useSWR<unknown>(
    sessionId && model ? (`/api/sessions/${sessionId}/subscription` as const) : null
  );
  if (!model) return null;
  const parsed = sessionSubscriptionResponseSchema.safeParse(data);
  if (!parsed.success) return null;
  const { provider } = extractProviderAndModel(model);
  return parsed.data.subscriptions.find((entry) => entry.provider === provider) ?? null;
}
