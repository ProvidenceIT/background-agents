import {
  SESSION_SUBSCRIPTION_PRODUCT_NAMES,
  type SessionSubscription,
  type SessionSubscriptionSlot,
} from "@open-inspect/shared/types/session-subscription";

/** "Your Claude subscription", "Ada's shared Claude subscription", "Workspace API key", ... */
export function describeSessionSubscription(subscription: SessionSubscription): string {
  // Bound but unusable on this session's agent: nothing pays, so turns cannot run (BUG-01).
  const holder = describeHolder(subscription);
  if (subscription.payer !== "none") return holder;
  // Lower-case the leading word mid-sentence, but never a colleague's name.
  const inline = /^(Your|A|Workspace)\b/.test(holder)
    ? holder[0].toLowerCase() + holder.slice(1)
    : holder;
  return `None: this agent cannot use ${inline}`;
}

function describeHolder(subscription: SessionSubscription): string {
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
