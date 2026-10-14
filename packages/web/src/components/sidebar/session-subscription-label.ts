import {
  SESSION_SUBSCRIPTION_PRODUCT_NAMES,
  type SessionSubscription,
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
