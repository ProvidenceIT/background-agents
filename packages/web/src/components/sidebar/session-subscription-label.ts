import {
  SESSION_SUBSCRIPTION_PRODUCT_NAMES,
  type SessionSubscription,
  type SessionSubscriptionSlot,
} from "@open-inspect/shared/types/session-subscription";

/** "Your Claude subscription", "Ada's shared Claude subscription", "Workspace API key", ... */
export function describeSessionSubscription(subscription: SessionSubscription): string {
  const product = SESSION_SUBSCRIPTION_PRODUCT_NAMES[subscription.provider];
  if (subscription.holder === "workspace") {
    return subscription.authMode === "api_key"
      ? `Workspace ${product} API key`
      : `Workspace ${product} credentials`;
  }
  const kind = `${subscription.shared ? "shared " : ""}${product} subscription`;
  const owner =
    subscription.holder === "you"
      ? "Your"
      : subscription.holderDisplayName
        ? `${subscription.holderDisplayName}'s`
        : "A colleague's";
  const account = subscription.accountDisplayName ? ` (${subscription.accountDisplayName})` : "";
  return `${owner} ${kind}${account}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "claude-3", or "claude-3 · 5 turns, claude-7 · 2 turns" when turns spread over slots. */
export function describeSubscriptionSlots(
  slots: readonly SessionSubscriptionSlot[]
): string | null {
  if (slots.length === 0) return null;
  if (slots.length === 1) return slots[0].slot;
  return slots.map((entry) => `${entry.slot} · ${plural(entry.turns, "turn")}`).join(", ");
}
