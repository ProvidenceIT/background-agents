import {
  SUBSCRIPTION_PROVIDER_DISPLAY_METADATA,
  type SessionSubscription,
} from "@open-inspect/shared/types/provider-accounts";

/** "Your Claude subscription", "Ada's shared Claude subscription", "Workspace API key", ... */
export function describeSessionSubscription(subscription: SessionSubscription): string {
  const product = SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[subscription.provider].subscriptionName;
  if (subscription.holder === "workspace") {
    return subscription.authMode === "api_key"
      ? "Workspace API key"
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
