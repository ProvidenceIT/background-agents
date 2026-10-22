"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/prompts";
import type {
  ForkSessionRequest,
  ForkSubscriptionSlot,
} from "@open-inspect/shared/types/session-api";
import { ModelReasoningSelector } from "@/components/model-reasoning-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import type { ModelPreference } from "@/lib/model-selection";
import { resolveHarnessModelSelection } from "@/lib/session-harness";
import {
  createSessionFork,
  fetchForkHandoff,
  fetchForkSubscriptionSlots,
} from "@/lib/session-fork";

export interface ForkSource {
  id: string;
  title: string | null;
  harness: HarnessId;
  model: string | null | undefined;
  reasoningEffort: string | null | undefined;
}

interface ForkSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ForkSource;
}

export function ForkSessionDialog({ open, onOpenChange, source }: ForkSessionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted per open, so each open gets its own fork request id and a fresh draft. */}
      {open && <ForkSessionForm source={source} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

type HandoffDraft =
  { status: "loading" } | { status: "ready" } | { status: "failed"; message: string };

function useHandoffDraft(sessionId: string) {
  const [draft, setDraft] = useState<HandoffDraft>({ status: "loading" });
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchForkHandoff(sessionId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setText(result.value);
        setDraft({ status: "ready" });
      } else {
        setDraft({ status: "failed", message: result.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  const retry = () => {
    setDraft({ status: "loading" });
    setAttempt((value) => value + 1);
  };
  return { draft, text, setText, retry };
}

function useForkModelSelection(source: ForkSource) {
  const [harness, setHarness] = useState<HarnessId>(source.harness);
  const [preference, setPreference] = useState<ModelPreference>({
    model: source.model ?? DEFAULT_MODEL,
    reasoningEffort: source.reasoningEffort ?? undefined,
  });
  const { enabledModels, enabledModelOptions, loading } = useEnabledModels();
  const selection = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness,
        preference,
        enabledModels,
        enabledModelOptions,
        loading,
      }),
    [enabledModelOptions, enabledModels, harness, loading, preference]
  );
  return {
    harness,
    setHarness,
    selection,
    onModelChange: (model: ValidModel) =>
      setPreference({ model, reasoningEffort: getDefaultReasoningEffort(model) }),
    onReasoningEffortChange: (reasoningEffort: ReasoningEffort | undefined) =>
      setPreference({ model: selection.model, reasoningEffort }),
  };
}

/** The only harness whose pool slots a fork can pin. */
const PINNABLE_SLOT_HARNESS: HarnessId = "claude";

/** Select value for "no preference"; the colon keeps it apart from every valid slot name. */
const AUTOMATIC_SLOT_VALUE = ":automatic";

/** Slots the caller's home offers for the harness; empty until loaded, on failure, or elsewhere. */
function useForkSubscriptionSlots(sessionId: string, harness: HarnessId) {
  const [loaded, setLoaded] = useState<{ harness: HarnessId; slots: ForkSubscriptionSlot[] }>({
    harness,
    slots: [],
  });
  const pinnable = harness === PINNABLE_SLOT_HARNESS;

  useEffect(() => {
    if (!pinnable) return;
    let cancelled = false;
    void fetchForkSubscriptionSlots(sessionId, harness).then((result) => {
      if (!cancelled) setLoaded({ harness, slots: result.ok ? result.value : [] });
    });
    return () => {
      cancelled = true;
    };
  }, [harness, pinnable, sessionId]);

  return pinnable && loaded.harness === harness ? loaded.slots : [];
}

function slotLabel({ slot, percentRemaining }: ForkSubscriptionSlot) {
  return percentRemaining === null ? slot : `${slot} (${percentRemaining}%)`;
}

function ForkSessionForm({ source, onClose }: { source: ForkSource; onClose: () => void }) {
  const router = useRouter();
  // Reused on retries so a request that reached the server but lost its response replays the
  // same fork instead of creating a second one.
  const [forkRequestId] = useState(() => crypto.randomUUID());
  const { draft, text, setText, retry } = useHandoffDraft(source.id);
  const model = useForkModelSelection(source);
  const slots = useForkSubscriptionSlots(source.id, model.harness);
  const [chosenSlot, setChosenSlot] = useState<string | null>(null);
  // A slot chosen for one agent, or one the refreshed list dropped, falls back to automatic.
  const subscriptionSlot = slots.some((slot) => slot.slot === chosenSlot) ? chosenSlot : null;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const tooLong = text.length > MAX_WEB_PROMPT_CHARS;
  const modelUnavailable = model.selection.availability.status !== "available";
  const createDisabled = submitting || draft.status === "loading" || tooLong || modelUnavailable;

  const handleCreate = async () => {
    if (createDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    const request: ForkSessionRequest = {
      forkRequestId,
      harness: model.harness,
      model: model.selection.model,
      ...(model.selection.reasoningEffort
        ? { reasoningEffort: model.selection.reasoningEffort }
        : {}),
      // A blank draft lets the server build its own handoff.
      ...(text.trim() ? { handoff: text } : {}),
      ...(subscriptionSlot ? { subscriptionSlot } : {}),
    };
    const result = await createSessionFork(source.id, request);
    if (!result.ok) {
      setSubmitError(result.message);
      setSubmitting(false);
      return;
    }
    onClose();
    router.push(`/session/${encodeURIComponent(result.value.sessionId)}`);
  };

  // Closing mid-request would drop its error and navigate after the user dismissed the dialog.
  const keepOpenWhileSubmitting = (event: Event) => {
    if (submitting) event.preventDefault();
  };

  return (
    <DialogContent
      className="max-h-[calc(100vh-2rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto sm:w-full"
      onEscapeKeyDown={keepOpenWhileSubmitting}
      onInteractOutside={keepOpenWhileSubmitting}
    >
      <div>
        <DialogTitle>Fork session</DialogTitle>
        <DialogDescription className="mt-1.5">
          Start a new session from {source.title ? `“${source.title}”` : "this session"} with a
          handoff prompt. The original session stays open.
        </DialogDescription>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ModelReasoningSelector
          selectedModel={model.selection.model}
          reasoningEffort={model.selection.reasoningEffort}
          items={model.selection.options}
          onModelChange={model.onModelChange}
          onReasoningEffortChange={model.onReasoningEffortChange}
          harness={model.harness}
          onHarnessChange={model.setHarness}
          disabled={submitting}
        />
      </div>
      {slots.length > 1 && (
        <div className="grid gap-1.5">
          <Label htmlFor="fork-subscription">Subscription</Label>
          <Select
            value={subscriptionSlot ?? AUTOMATIC_SLOT_VALUE}
            onValueChange={(value) => setChosenSlot(value === AUTOMATIC_SLOT_VALUE ? null : value)}
            disabled={submitting}
          >
            <SelectTrigger id="fork-subscription" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC_SLOT_VALUE}>Automatic (most headroom)</SelectItem>
              {slots.map((slot) => (
                <SelectItem key={slot.slot} value={slot.slot}>
                  {slotLabel(slot)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {model.selection.availability.status === "unavailable" && (
        <p className="text-sm text-destructive">{model.selection.availability.message}</p>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="fork-handoff">Handoff prompt</Label>
        <Textarea
          id="fork-handoff"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={submitting || draft.status === "loading"}
          placeholder={draft.status === "loading" ? "Loading the handoff draft…" : undefined}
          aria-describedby="fork-handoff-help"
          className="min-h-64 font-mono text-xs"
        />
        <p id="fork-handoff-help" className="text-xs text-muted-foreground">
          Sent as the first message of the new session. Edit it freely.
        </p>
        {draft.status === "failed" && (
          <p role="alert" className="text-sm text-destructive">
            {draft.message} Write a prompt yourself, leave it empty to let the server draft one, or{" "}
            <button type="button" className="underline" onClick={retry}>
              retry
            </button>
            .
          </p>
        )}
        {tooLong && (
          <p role="alert" className="text-sm text-destructive">
            The handoff prompt is {text.length} characters; the limit is {MAX_WEB_PROMPT_CHARS}.
          </p>
        )}
      </div>

      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={() => void handleCreate()} disabled={createDisabled}>
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </DialogContent>
  );
}
