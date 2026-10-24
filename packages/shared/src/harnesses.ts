/**
 * Agent harness catalog.
 *
 * A session runs on exactly one harness — the agent that sits behind the
 * sandbox runtime's `AgentHarness` seam. The catalog is the declared
 * capability record for each harness, and `checkHarnessCompatibility` is the
 * one rule applied wherever a model or a provider-auth selection enters a
 * session.
 *
 * An id enters the catalog together with the runtime that boots it: the
 * catalog is exactly the set a session can be created on, never a wider set
 * of recognized names.
 */

import { z } from "zod";
import { extractProviderAndModel } from "./models";
import type {
  ModelProviderSelections,
  ProviderAuthMode,
  SessionProviderAuthMode,
} from "./types/provider-accounts";
import {
  payerForAuthMode,
  type RunnabilityReason,
  type SetupRunnability,
} from "./types/runnability";

export const HARNESS_IDS = ["opencode", "claude", "codex", "grok", "agy"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const DEFAULT_HARNESS: HarnessId = "opencode";
export const harnessIdSchema = z.enum(HARNESS_IDS);

export interface HarnessCapabilities {
  /** User-facing name. Never "Claude Code" (branding rule). */
  readonly label: string;
  /** Model providers (catalog id prefixes) the harness can run, or any. */
  readonly modelFamilies: "any" | readonly string[];
  /**
   * The model a new session on this harness starts on when the user's
   * preference cannot run here; absent means the catalog default.
   */
  readonly defaultModel?: string;
  /** Provider id → auth modes the harness can *select* for that provider. */
  readonly providerAuth: Readonly<Partial<Record<string, readonly ProviderAuthMode[]>>>;
  /**
   * Catalog ids the harness can run within its families; absent means every
   * model of those families.
   */
  readonly allowedModels?: readonly string[];
  /** How a sandbox restore resumes the conversation. */
  readonly resume: "session_id";
}

export const HARNESS_CATALOG = {
  opencode: {
    label: "OpenCode",
    modelFamilies: "any",
    providerAuth: {
      openai: ["api_key", "provider_account", "auth_home"],
      // A home carrying xai holds a pushed SuperGrok token, which only the
      // grok CLI reads; OpenCode has no credential for it there.
      xai: ["api_key", "provider_account"],
    },
    resume: "session_id",
  },
  claude: {
    label: "Claude Agent",
    modelFamilies: ["anthropic"],
    providerAuth: {
      anthropic: ["api_key", "provider_account", "auth_home"],
    },
    resume: "session_id",
  },
  // ChatGPT through the Codex CLI, on the `auth.json` a subscription home
  // carries. There is no key path: Codex reads and refreshes that file itself,
  // so a session runs only where the resolver bound a home.
  codex: {
    label: "Codex",
    modelFamilies: ["openai"],
    // A ChatGPT login refuses older catalog models (gpt-5.4: "not supported
    // when using Codex with a ChatGPT account"), so the first enabled OpenAI
    // model is not a safe fallback.
    defaultModel: "openai/gpt-6.1-sol",
    providerAuth: {
      openai: ["auth_home"],
    },
    resume: "session_id",
  },
  // SuperGrok through the grok CLI, on the access token the subscription
  // home's push keeps fresh. The CLI refreshes nothing in the sandbox, so
  // there is no key path either.
  grok: {
    label: "SuperGrok",
    modelFamilies: ["xai"],
    defaultModel: "xai/grok-4.7-build-fast",
    // What `grok models` lists for a SuperGrok login; it does not serve
    // xai/grok-build-0.1.
    allowedModels: ["xai/grok-4.7", "xai/grok-4.7-build-fast", "xai/grok-4.6", "xai/grok-4.5"],
    providerAuth: {
      xai: ["auth_home"],
    },
    resume: "session_id",
  },
  // Google Antigravity through the agy CLI, on the same pushed-token path.
  // agy also serves Claude models; those stay out of the catalog, since
  // Anthropic models run only on Claude Agent.
  agy: {
    label: "Antigravity",
    modelFamilies: ["antigravity"],
    defaultModel: "antigravity/gemini-4-argon",
    providerAuth: {
      antigravity: ["auth_home"],
    },
    resume: "session_id",
  },
} as const satisfies Record<HarnessId, HarnessCapabilities>;

/**
 * Providers whose models run on one harness only, whatever a family list
 * says: Anthropic models run only on Claude Agent, Antigravity models only
 * on agy. A bare model id counts as Anthropic.
 */
export const MODEL_PROVIDER_HARNESS: Readonly<Partial<Record<string, HarnessId>>> = {
  anthropic: "claude",
  antigravity: "agy",
};

export function isValidHarness(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

/** Resolve a harness from an optional wire value; absent means the built-in harness. */
export function getValidHarnessOrDefault(value: string | null | undefined): HarnessId {
  return isValidHarness(value) ? value : DEFAULT_HARNESS;
}

export function getHarnessCapabilities(harness: HarnessId): HarnessCapabilities {
  // Widen the literal catalog entry to the interface so callers index by string.
  return HARNESS_CATALOG[harness] as HarnessCapabilities;
}

export function getHarnessLabel(harness: HarnessId): string {
  return HARNESS_CATALOG[harness].label;
}

/**
 * Whether the harness can run a model: by its provider pin, then its catalog
 * provider prefix, then the harness's allowed model ids.
 */
export function harnessSupportsModel(harness: HarnessId, model: string): boolean {
  const { provider, model: name } = extractProviderAndModel(model);
  const pinned = MODEL_PROVIDER_HARNESS[provider];
  if (pinned && pinned !== harness) return false;
  const { modelFamilies, allowedModels } = getHarnessCapabilities(harness);
  if (modelFamilies !== "any" && !modelFamilies.includes(provider)) return false;
  return !allowedModels || allowedModels.includes(`${provider}/${name}`);
}

/** The harness a model runs on when nothing configures one: its pin, else the built-in harness. */
export function harnessForModel(model: string): HarnessId {
  return MODEL_PROVIDER_HARNESS[extractProviderAndModel(model).provider] ?? DEFAULT_HARNESS;
}

/** Whether the harness runs the provider on a subscription home and nothing else. */
function runsOnlyOnAuthHome(harness: HarnessId, provider: string): boolean {
  const modes = getHarnessCapabilities(harness).providerAuth[provider];
  return !!modes && modes.length > 0 && modes.every((mode) => mode === "auth_home");
}

/**
 * Whether the harness can run a provider under an auth mode.
 * `legacy_scoped_oauth` is resolver-assigned, not selectable, and passes
 * through, except where the harness runs the provider only on a home.
 */
export function harnessSupportsProviderAuth(
  harness: HarnessId,
  provider: string,
  mode: SessionProviderAuthMode
): boolean {
  if (mode === "legacy_scoped_oauth") return !runsOnlyOnAuthHome(harness, provider);
  const modes = getHarnessCapabilities(harness).providerAuth[provider];
  // No row means the harness does not run the provider at all, so it cannot
  // select any auth mode for it either. The model check reports that to the
  // user; the auth resolver falls back to the API key.
  return modes !== undefined && modes.includes(mode);
}

/**
 * The harness a session launched by an integration runs `model` on: the
 * configured harness when it can run the model, else the model's own harness
 * (`harnessForModel`). Integrations resolve the model at launch from sources
 * a saved harness cannot constrain (issue labels, user preferences,
 * deployment defaults), so the configured harness is a preference that never
 * strands a launch on a model it cannot run. Absent means the model's harness.
 */
export function resolveHarnessForModel(
  configured: HarnessId | undefined,
  model: string
): HarnessId {
  return configured && harnessSupportsModel(configured, model)
    ? configured
    : harnessForModel(model);
}

/** Models from a list that the harness can run. */
export function filterModelsForHarness<T extends string>(
  harness: HarnessId,
  models: readonly T[]
): T[] {
  return models.filter((model) => harnessSupportsModel(harness, model));
}

/**
 * The auth mode each explicit provider selection asks for, in the shape
 * `checkHarnessCompatibility` takes. Providers without a selection are left
 * out: they resolve later, against the harness, in the auth resolver.
 */
export function selectedProviderAuthModes(
  selections: ModelProviderSelections
): Partial<Record<string, SessionProviderAuthMode>> {
  return Object.fromEntries(
    Object.entries(selections).flatMap(([provider, selection]) =>
      selection ? [[provider, selection.mode]] : []
    )
  );
}

/**
 * Explicit selections the harness can honour. A selection is dropped only
 * when the harness runs that provider but not in the selected mode (an
 * Anthropic account on OpenCode): kept, it would fail every session or run
 * created with it. A provider the harness does not run at all cannot be
 * reached through it, so that selection survives a switch back untouched.
 * Returns the same object when nothing changes.
 */
export function reconcileProviderSelectionsForHarness(
  harness: HarnessId,
  selections: ModelProviderSelections
): ModelProviderSelections {
  const providerAuth = getHarnessCapabilities(harness).providerAuth;
  const next: ModelProviderSelections = {};
  let changed = false;
  for (const [provider, selection] of Object.entries(selections)) {
    if (!selection) continue;
    const modes = providerAuth[provider];
    if (modes !== undefined && !modes.includes(selection.mode)) {
      changed = true;
      continue;
    }
    next[provider as keyof ModelProviderSelections] = selection;
  }
  return changed ? next : selections;
}

export interface HarnessCompatibilityError {
  readonly code: "model" | "provider_auth";
  readonly message: string;
}

/**
 * The one compatibility rule: can `harness` run `model` under the session's
 * resolved provider-auth modes? Applied at session create, prompt admission,
 * queued-message dispatch, child spawn, automation save, and installation
 * default resolution. Returns null when compatible.
 */
export function checkHarnessCompatibility(
  harness: HarnessId,
  model: string,
  providerAuthModes?: Readonly<Partial<Record<string, SessionProviderAuthMode>>>
): HarnessCompatibilityError | null {
  const label = getHarnessLabel(harness);
  const { provider } = extractProviderAndModel(model);
  if (!harnessSupportsModel(harness, model)) {
    const pinned = MODEL_PROVIDER_HARNESS[provider];
    const hint =
      pinned && pinned !== harness
        ? ` It runs only on ${getHarnessLabel(pinned)}; fork this session onto ${getHarnessLabel(pinned)}.`
        : "";
    return {
      code: "model",
      message: `Model "${model}" cannot run on the ${label} harness.${hint}`,
    };
  }
  const mode = providerAuthModes?.[provider];
  if (mode && !harnessSupportsProviderAuth(harness, provider, mode)) {
    return { code: "provider_auth", message: providerAuthMessage(harness, provider, mode) };
  }
  return null;
}

/**
 * Whether `harness` can run `model` on the credential bound for the model's
 * provider, and who pays. `authBinding` holds the auth mode per provider: the
 * session's resolved auth, or an automation's explicit selections (a provider
 * left out resolves when a run starts, so it is not judged here).
 *
 * A bound mode is a mismatch when the harness declares the auth it can use
 * for the provider and the mode is not among it, or when the harness cannot
 * run the model at all (OpenCode on a Claude subscription home: the turn
 * would otherwise fail with "Anthropic API key is missing"). A provider the
 * harness runs on credentials outside the selectable modes (Z.AI secrets on
 * OpenCode) is not a mismatch.
 */
export function assessRunnability(
  harness: HarnessId,
  model: string,
  authBinding: Readonly<Partial<Record<string, SessionProviderAuthMode>>> = {}
): SetupRunnability {
  const { provider } = extractProviderAndModel(model);
  const mode = authBinding[provider];
  const modelRuns = harnessSupportsModel(harness, model);
  const reasons: RunnabilityReason[] = [];
  if (
    mode &&
    !harnessSupportsProviderAuth(harness, provider, mode) &&
    (getHarnessCapabilities(harness).providerAuth[provider] !== undefined || !modelRuns)
  ) {
    const pinned = MODEL_PROVIDER_HARNESS[provider];
    reasons.push({
      code: "payer_mismatch",
      // A provider pinned elsewhere is paid on no credential here, so name the
      // harness that can pay instead of another mode that would fail too.
      message:
        mode !== "auth_home" && pinned && pinned !== harness
          ? `The ${getHarnessLabel(harness)} harness cannot use ${provider} credentials; use the ${getHarnessLabel(pinned)} harness.`
          : providerAuthMessage(harness, provider, mode),
    });
  }
  if (!modelRuns) {
    const incompatibility = checkHarnessCompatibility(harness, model);
    reasons.push({ code: "model_unsupported", message: incompatibility!.message });
  }
  if (reasons.length > 0) return { runnable: false, payer: "none", reasons };
  if (mode) return { runnable: true, payer: payerForAuthMode(mode), reasons };
  // Nothing bound: a harness that runs the provider only on a home is paid by
  // one; any other resolves its payer when a run starts.
  return {
    runnable: true,
    payer: runsOnlyOnAuthHome(harness, provider) ? "subscription" : "none",
    reasons,
  };
}

function providerAuthMessage(
  harness: HarnessId,
  provider: string,
  mode: SessionProviderAuthMode
): string {
  const label = getHarnessLabel(harness);
  if (runsOnlyOnAuthHome(harness, provider)) {
    return `The ${label} harness runs ${provider} only on a subscription home; enrol one under Settings > Subscription homes.`;
  }
  if (mode === "auth_home") {
    const other = HARNESS_IDS.find((id) => harnessSupportsProviderAuth(id, provider, mode));
    const hint = other ? `; use the ${getHarnessLabel(other)} harness` : "";
    return `The ${label} harness cannot run ${provider} on a subscription home${hint}.`;
  }
  return mode === "provider_account"
    ? `The ${label} harness cannot use a connected ${provider} account; select an API key for this session.`
    : `The ${label} harness cannot run ${provider} in ${mode} mode.`;
}
