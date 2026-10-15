/**
 * Progress in the thread: tool-call callbacks become lines under the
 * "Working..." reply, edited in place. One stream per thread feeds the ported
 * conflater, so a burst of callbacks that arrives while an edit is in flight
 * becomes one further edit, not one per callback; the streaming reply sink
 * does the edits and falls back to a fresh post when the connector refuses
 * one. The completion drains the stream before it writes the final text, so
 * no progress edit can land after the answer.
 *
 * A thread can hold more than one conversation (its own session and
 * colleagues' forks), each with its own "Working..." reply, so streams are
 * keyed per conversation (`progressStreamKey`), not per thread.
 *
 * In memory on purpose: after a restart the lines of the turn so far are
 * gone, and the next callback starts again from "Working..." on the activity
 * the SQLite record names.
 */

import { asError, type Logger } from "../logger";
import { conflateTeamsRenderStream, type TeamsRenderChunk } from "../teams/conflate";
import {
  createStreamingEditReplySink,
  WORKING_TEXT,
  type ReplySinkPort,
} from "../teams/reply-sink";

/** Lines shown under "Working..."; older ones scroll off. */
const MAX_PROGRESS_LINES = 6;
const MAX_LINE_LENGTH = 120;

interface ProgressTarget {
  port: ReplySinkPort;
  /** The "Working..." reply to edit; `null` when its id was not recorded, in which case one is posted. */
  progressActivityId: string | null;
}

/** The stream key of one conversation in a thread: the thread's own session, or a fork. */
export function progressStreamKey(threadKey: string, sessionId: string): string {
  return `${threadKey}|${sessionId}`;
}

export interface ProgressRenderer {
  /** Add a line to the conversation's progress; the edit happens in the background. */
  note(streamKey: string, target: ProgressTarget, line: string): void;
  /**
   * End the conversation's progress stream and wait for its last edit. Resolves to
   * the activity that holds the progress text (it moves when an edit had to
   * fall back to a post), or `undefined` when no progress was rendered. With
   * `forActivityId`, only a stream started for that placeholder is ended; a
   * stream that belongs to another turn is left alone and `undefined` is
   * returned.
   */
  finish(streamKey: string, forActivityId?: string | null): Promise<string | undefined>;
}

interface ChunkSource {
  iterable: AsyncIterable<TeamsRenderChunk>;
  push(chunk: TeamsRenderChunk): void;
}

/** A push-fed async iterable; `done`/`error` chunks end it after they are consumed. */
function createChunkSource(): ChunkSource {
  const queue: TeamsRenderChunk[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<TeamsRenderChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<TeamsRenderChunk>> {
          while (queue.length === 0) {
            if (ended) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const chunk = queue.shift()!;
          if (chunk.type !== "text_delta") ended = true;
          return { done: false, value: chunk };
        },
        async return(): Promise<IteratorResult<TeamsRenderChunk>> {
          ended = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    iterable,
    push(chunk) {
      queue.push(chunk);
      const resume = wake;
      wake = undefined;
      resume?.();
    },
  };
}

export function renderProgressText(lines: readonly string[]): string {
  const shown = lines.slice(-MAX_PROGRESS_LINES).map((line) => `- ${line}`);
  return shown.length === 0 ? WORKING_TEXT : `${WORKING_TEXT}\n\n${shown.join("\n")}`;
}

function clipLine(line: string): string {
  const single = line.replace(/\s+/g, " ").trim();
  return single.length > MAX_LINE_LENGTH ? `${single.slice(0, MAX_LINE_LENGTH - 1)}…` : single;
}

interface ConversationProgress {
  /** The activity the stream was started for; a different one means a new turn. */
  forActivityId: string | null;
  source: ChunkSource;
  lines: string[];
  settled: Promise<string | undefined>;
}

export function createProgressRenderer(log: Logger): ProgressRenderer {
  const streams = new Map<string, ConversationProgress>();

  async function run(streamKey: string, state: ConversationProgress, target: ProgressTarget) {
    const sink = createStreamingEditReplySink(target.port, target.progressActivityId ?? undefined);
    let activityId = target.progressActivityId ?? undefined;
    try {
      activityId = (await sink.begin()).progressActivityId ?? activityId;
    } catch (error) {
      log.warn("progress.begin_failed", { stream_key: streamKey, error: asError(error) });
    }
    for await (const chunk of conflateTeamsRenderStream(state.source.iterable)) {
      if (chunk.type !== "text_delta") break;
      state.lines.push(...chunk.text.split("\n").filter((line) => line !== ""));
      try {
        const result = await sink.emit(chunk.text, renderProgressText(state.lines));
        if (result?.progressActivityId) activityId = result.progressActivityId;
      } catch (error) {
        log.warn("progress.edit_failed", { stream_key: streamKey, error: asError(error) });
      }
    }
    return activityId;
  }

  function start(streamKey: string, target: ProgressTarget): ConversationProgress {
    const state: ConversationProgress = {
      forActivityId: target.progressActivityId,
      source: createChunkSource(),
      lines: [],
      settled: Promise.resolve(undefined),
    };
    state.settled = run(streamKey, state, target);
    streams.set(streamKey, state);
    return state;
  }

  return {
    note(streamKey, target, line) {
      let state = streams.get(streamKey);
      if (state && state.forActivityId !== target.progressActivityId) {
        state.source.push({ type: "done" });
        state = undefined;
      }
      state ??= start(streamKey, target);
      state.source.push({ type: "text_delta", text: `\n${clipLine(line)}` });
    },
    async finish(streamKey, forActivityId) {
      const state = streams.get(streamKey);
      if (!state) return undefined;
      if (forActivityId !== undefined && state.forActivityId !== forActivityId) return undefined;
      streams.delete(streamKey);
      state.source.push({ type: "done" });
      return state.settled;
    },
  };
}
