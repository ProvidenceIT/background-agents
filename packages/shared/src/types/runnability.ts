/**
 * Whether a setup (harness + model + the credential bound for the model's
 * provider) can run a turn, and who pays for it. `assessRunnability` in
 * `../harnesses` computes it; session admission, automation save, the web
 * forms and the session Info panel all read the same verdict.
 */

import type { SessionProviderAuthMode } from "./provider-accounts";

/**
 * Who pays for the model's provider. `subscription`: a subscription home.
 * `provider_account`: a connected provider account. `api_key`: the workspace
 * (an installation API key, a secret, or a legacy workspace credential).
 * `none`: nothing the harness can use is bound — either nothing is bound yet
 * (a run resolves it when it starts) or the bound credential is one the
 * harness cannot use.
 */
export const RUNNABILITY_PAYERS = ["subscription", "provider_account", "api_key", "none"] as const;
export type RunnabilityPayer = (typeof RUNNABILITY_PAYERS)[number];

/** Who pays when a harness that can use `mode` runs on it. */
export function payerForAuthMode(mode: SessionProviderAuthMode): RunnabilityPayer {
  if (mode === "auth_home") return "subscription";
  if (mode === "provider_account") return "provider_account";
  // An API key or the legacy workspace OAuth credential: the workspace pays.
  return "api_key";
}

/**
 * Why a setup cannot run. `payer_mismatch`: the credential bound for the
 * model's provider is one the harness cannot use (OpenCode on a Claude
 * subscription home). `model_unsupported`: the harness cannot run the model.
 */
export type RunnabilityReasonCode = "payer_mismatch" | "model_unsupported";

export interface RunnabilityReason {
  code: RunnabilityReasonCode;
  message: string;
}

export interface SetupRunnability {
  runnable: boolean;
  payer: RunnabilityPayer;
  /** Empty exactly when `runnable`. */
  reasons: RunnabilityReason[];
}

/** Error code of the 422 that refuses to save a setup that cannot run. */
export const NOT_RUNNABLE = "not_runnable" as const;
