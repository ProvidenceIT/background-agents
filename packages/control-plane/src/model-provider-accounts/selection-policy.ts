import { MODEL_PROVIDER_ACCOUNT_ID_PATTERN } from "@open-inspect/shared/types/provider-accounts";
import type {
  ModelProviderAccount,
  ModelProviderAccountStore,
} from "../db/model-provider-accounts";
import type { ModelProviderId } from "./provider-auth-contracts";
import { providerAccountIneligibility } from "./account-lifecycle-policy";

type ProviderAccountPolicyStatus = 400 | 403 | 404 | 409;

export interface ProviderAccountAdapterLookup {
  get(provider: ModelProviderId): object | undefined;
}

export class ProviderAccountSelectionPolicyError extends Error {
  constructor(
    message: string,
    readonly status: ProviderAccountPolicyStatus
  ) {
    super(message);
  }
}

export class ProviderAccountSelectionPolicy {
  constructor(
    private readonly accounts: Pick<ModelProviderAccountStore, "getById">,
    private readonly adapters: ProviderAccountAdapterLookup
  ) {}

  /**
   * An account may be spent only by its owner's own activity: `actorUserId`
   * is the user whose session or automation would use it, and an account
   * owned by anyone else (or by nobody) is refused with 403.
   */
  validateSelection(
    provider: ModelProviderId,
    providerAccountId: string,
    actorUserId: string | null
  ): Promise<ModelProviderAccount> {
    return this.validateActiveAccount(provider, providerAccountId, actorUserId, "Selected");
  }

  validateDefault(
    provider: ModelProviderId,
    providerAccountId: string,
    actorUserId: string | null
  ): Promise<ModelProviderAccount> {
    return this.validateActiveAccount(provider, providerAccountId, actorUserId, "Default");
  }

  private async validateActiveAccount(
    provider: ModelProviderId,
    providerAccountId: string,
    actorUserId: string | null,
    source: "Selected" | "Default"
  ): Promise<ModelProviderAccount> {
    if (!MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(providerAccountId)) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} provider account ID is invalid`,
        400
      );
    }
    if (!this.adapters.get(provider)) {
      throw new ProviderAccountSelectionPolicyError(
        `${provider} provider account adapter is unavailable`,
        409
      );
    }

    const account = await this.accounts.getById(providerAccountId);
    if (!account) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} ${provider} provider account was not found`,
        404
      );
    }
    if (account.provider !== provider) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} provider account does not belong to ${provider}`,
        400
      );
    }
    if (providerAccountIneligibility(account, "active_use")) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} ${provider} provider account is unavailable`,
        409
      );
    }
    if (account.ownerUserId === null || account.ownerUserId !== actorUserId) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} ${provider} provider account belongs to another user; a subscription is spent only by its owner's own activity`,
        403
      );
    }
    return account;
  }
}
