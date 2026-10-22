import {
  DEFAULT_HARNESS,
  MODEL_PROVIDER_HARNESS,
  filterModelsForHarness,
  getHarnessCapabilities,
  getHarnessLabel,
  harnessSupportsModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { ModelCategory, ReasoningEffort, ValidModel } from "@open-inspect/shared/models";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";

/**
 * The enabled models a harness can run: Codex only OpenAI's (served from a
 * subscription home), the Claude harness only Anthropic's, OpenCode every
 * model no other harness is pinned to.
 */
export function modelsForHarness<T extends string>(
  harness: HarnessId,
  enabledModels: readonly T[]
): T[] {
  return filterModelsForHarness(harness, enabledModels);
}

/** The harness a model is pinned to when that is not `harness`, else null. */
function pinnedElsewhere(harness: HarnessId, model: string): HarnessId | null {
  const pinned = MODEL_PROVIDER_HARNESS[extractProviderAndModel(model).provider];
  return pinned && pinned !== harness ? pinned : null;
}

/**
 * The harness a picker whose harness follows the model lands on once `model`
 * is chosen: the harness the model is pinned to (Anthropic's to Claude Agent,
 * Antigravity's to agy), else `harness`. An unpinned model the harness cannot
 * run keeps the harness, which then coerces the model to one it can run. An
 * unset model ("use the default") keeps the harness too.
 */
export function harnessForModelPick(harness: HarnessId, model: string): HarnessId {
  return (model && pinnedElsewhere(harness, model)) || harness;
}

/**
 * Model picker groups reduced to the models the harness can run. With
 * `switchable`, a picker whose harness follows the model also keeps the models
 * pinned to another harness (Anthropic's to Claude Agent), labelled with the
 * harness picking one switches to.
 */
export function filterModelOptionsForHarness(
  harness: HarnessId,
  options: ModelCategory[],
  { switchable = false }: { switchable?: boolean } = {}
): ModelCategory[] {
  return options
    .map((group) => ({
      ...group,
      models: group.models.flatMap((model) => {
        if (harnessSupportsModel(harness, model.id)) return [model];
        const pinned = switchable ? pinnedElsewhere(harness, model.id) : null;
        return pinned ? [{ ...model, description: `Switches to ${getHarnessLabel(pinned)}` }] : [];
      }),
    }))
    .filter((group) => group.models.length > 0);
}

/**
 * Whether picking a harness must clear the current model (+effort): a set
 * model the new effective harness cannot run. Shared by the GitHub and Linear
 * settings (global + repo rows) so the picker can never silently produce a
 * pair the harness cannot run — mirroring the composer behavior. An unset
 * harness means the built-in default.
 */
export function shouldClearModelForHarness(harness: HarnessId | undefined, model: string): boolean {
  return model !== "" && !harnessSupportsModel(harness ?? DEFAULT_HARNESS, model);
}

export type HarnessModelAvailability =
  { status: "loading" } | { status: "available" } | { status: "unavailable"; message: string };

export interface HarnessModelSelection {
  /** Whether `model` may be submitted; anything else holds submission. */
  availability: HarnessModelAvailability;
  /** Picker groups holding only the enabled models the harness can run. */
  options: ModelCategory[];
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
}

/**
 * The one harness-aware model selection every composer derives its picker,
 * its submitted model and its submit gate from. A preference the harness
 * cannot run resolves to an enabled model it can. While the enabled set loads,
 * or when the harness can run none of the enabled models, the preference
 * stands for display only and `availability` says why nothing may be sent.
 */
export function resolveHarnessModelSelection({
  harness,
  preference,
  enabledModels,
  enabledModelOptions,
  loading,
  switchable = false,
}: {
  harness: HarnessId;
  preference: ModelPreference;
  enabledModels: readonly string[];
  enabledModelOptions: ModelCategory[];
  loading: boolean;
  /** The picker's harness follows the model; see `filterModelOptionsForHarness`. */
  switchable?: boolean;
}): HarnessModelSelection {
  const options = filterModelOptionsForHarness(harness, enabledModelOptions, { switchable });
  if (loading) {
    return { availability: { status: "loading" }, options, ...resolveModelPreference(preference) };
  }
  const models = filterModelsForHarness(harness, enabledModels);
  if (models.length === 0) {
    return {
      availability: {
        status: "unavailable",
        message: `No enabled models can run on ${getHarnessLabel(harness)}.`,
      },
      options,
      ...resolveModelPreference(preference),
    };
  }
  return {
    availability: { status: "available" },
    options,
    ...resolveModelPreference(preference, models, getHarnessCapabilities(harness).defaultModel),
  };
}
