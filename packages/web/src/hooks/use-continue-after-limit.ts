import { useCallback, useEffect, useRef } from "react";
import type { ContinueAfterLimitResult } from "@/components/limit-reached-banner";
import {
  promptRequestSignature,
  resolvePromptRequestIdentity,
  type PromptRequestIdentity,
} from "@/lib/prompt-request-id";
import { CONTINUE_AFTER_LIMIT_PROMPT } from "@/lib/turn-limit";
import type { useSessionSocket } from "./use-session-socket";

/**
 * Sends the banner's continue prompt. A retry after a failed send reuses the
 * same client request id, as the composer does, so a prompt the server already
 * queued before the acknowledgement was lost is replayed instead of doubled.
 */
export function useContinueAfterLimit(
  sendPrompt: ReturnType<typeof useSessionSocket>["sendPrompt"],
  selectedModel: string,
  reasoningEffort: string | undefined
): () => Promise<ContinueAfterLimitResult> {
  const retryRequestRef = useRef<PromptRequestIdentity | null>(null);
  useEffect(() => {
    retryRequestRef.current = null;
  }, [selectedModel, reasoningEffort]);

  return useCallback(async () => {
    const identity = resolvePromptRequestIdentity(
      promptRequestSignature({
        content: CONTINUE_AFTER_LIMIT_PROMPT,
        model: selectedModel,
        reasoningEffort,
        attachmentIds: [],
      }),
      retryRequestRef.current
    );
    retryRequestRef.current = identity;
    const result = await sendPrompt(
      CONTINUE_AFTER_LIMIT_PROMPT,
      selectedModel,
      reasoningEffort,
      undefined,
      identity.clientRequestId
    );
    if (result.ok) {
      retryRequestRef.current = null;
      return { ok: true };
    }
    return {
      ok: false,
      message:
        result.message ??
        (result.reason === "timeout"
          ? "Sending the continue prompt timed out."
          : result.reason === "disconnected"
            ? "Reconnect before continuing."
            : "The continue prompt was rejected."),
    };
  }, [reasoningEffort, selectedModel, sendPrompt]);
}
