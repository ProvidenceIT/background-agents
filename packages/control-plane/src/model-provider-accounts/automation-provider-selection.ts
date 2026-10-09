import {
  modelProviderSelectionsSchema,
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
} from "@open-inspect/shared/types/provider-accounts";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { SqlDatabase } from "../db/sql-database";
import { ProviderAccountSelectionPolicy } from "./selection-policy";

export class AutomationProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationProviderSelectionError";
  }
}

/**
 * Validate an automation's pinned provider selections. `executorUserId` is
 * the user the automation runs as: a pinned account must be theirs, since
 * every run spends it.
 */
export async function parseAndValidateAutomationProviderSelections(
  db: SqlDatabase,
  value: unknown,
  executorUserId: string | null
): Promise<ModelProviderSelections> {
  const parsed = modelProviderSelectionsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ["providerSelections", ...(issue?.path ?? [])].join(".");
    throw new AutomationProviderSelectionError(`${path}: ${issue?.message ?? "invalid"}`);
  }

  const policy = new ProviderAccountSelectionPolicy(
    new ModelProviderAccountStore(db),
    modelProviderAccountAdapterRegistry
  );
  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const selection = parsed.data[provider];
    if (!selection || selection.mode === "api_key") continue;
    await policy.validateSelection(provider, selection.accountId, executorUserId);
  }
  return parsed.data;
}
