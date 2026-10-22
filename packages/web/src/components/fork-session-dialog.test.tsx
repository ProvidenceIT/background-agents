// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import { ForkSessionDialog, type ForkSource } from "./fork-session-dialog";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModels: ["anthropic/claude-opus-5", "openai/gpt-5.5"],
    enabledModelOptions: MODEL_OPTIONS,
    loading: false,
  }),
}));

vi.mock("@/components/model-reasoning-selector", () => ({
  ModelReasoningSelector: ({
    harness,
    selectedModel,
    onHarnessChange,
  }: {
    harness?: string;
    selectedModel: string;
    onHarnessChange?: (harness: "codex") => void;
  }) => (
    <div>
      <span data-testid="agent">{`${harness} ${selectedModel}`}</span>
      <button type="button" onClick={() => onHarnessChange?.("codex")}>
        Switch agent to codex
      </button>
    </div>
  ),
}));

const SOURCE: ForkSource = {
  id: "session-1",
  title: "Refactor billing",
  harness: "claude",
  model: "anthropic/claude-opus-5",
  reasoningEffort: "high",
};

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    })
  );
  return calls;
}

function postedBodies(calls: FetchCall[]) {
  return calls
    .filter((call) => call.init?.method === "POST")
    .map((call) => JSON.parse(call.init?.body as string));
}

beforeEach(() => {
  push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ForkSessionDialog", () => {
  it("prefills the handoff draft and creates the fork with the source's agent", async () => {
    const calls = stubFetch(({ url }) =>
      url.endsWith("/handoff")
        ? Response.json({ handoff: "# Handoff\n\nGoal: finish billing." })
        : Response.json(
            { sessionId: "session-2", forkedFromSessionId: "session-1", created: true },
            { status: 201 }
          )
    );
    const onOpenChange = vi.fn();
    render(<ForkSessionDialog open onOpenChange={onOpenChange} source={SOURCE} />);

    expect(screen.getByText(/The original session stays open\./)).toBeInTheDocument();
    const textarea = await screen.findByDisplayValue(/Goal: finish billing\./);
    expect(calls[0].url).toBe("/api/sessions/session-1/fork/handoff");

    fireEvent.change(textarea, { target: { value: "# Handoff\n\nGoal: finish billing. Edited." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    const [body] = postedBodies(calls);
    expect(calls[1].url).toBe("/api/sessions/session-1/fork");
    expect(body).toEqual({
      forkRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      harness: "claude",
      model: "anthropic/claude-opus-5",
      reasoningEffort: "high",
      handoff: "# Handoff\n\nGoal: finish billing. Edited.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/session/session-2");
  });

  it("forks onto another agent with a model that agent can run", async () => {
    const calls = stubFetch(({ url }) =>
      url.endsWith("/handoff")
        ? Response.json({ handoff: "Draft" })
        : Response.json({ sessionId: "session-3", forkedFromSessionId: "session-1", created: true })
    );
    render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
    await screen.findByDisplayValue("Draft");

    fireEvent.click(screen.getByRole("button", { name: "Switch agent to codex" }));
    expect(screen.getByTestId("agent")).toHaveTextContent("codex openai/gpt-5.5");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(postedBodies(calls)[0]).toMatchObject({ harness: "codex", model: "openai/gpt-5.5" });
  });

  it("keeps the same fork request id when retrying after a failure", async () => {
    let attempts = 0;
    const calls = stubFetch(({ url }) => {
      if (url.endsWith("/handoff")) return Response.json({ handoff: "Draft" });
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "Session limit reached for your team" }, { status: 429 })
        : Response.json({
            sessionId: "session-2",
            forkedFromSessionId: "session-1",
            created: false,
          });
    });
    render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
    await screen.findByDisplayValue("Draft");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Session limit reached for your team");
    expect(push).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    const [first, second] = postedBodies(calls);
    expect(second.forkRequestId).toBe(first.forkRequestId);
    expect(push).toHaveBeenCalledWith("/session/session-2");
  });

  it("lets the server draft the handoff when loading it failed and the field stays empty", async () => {
    const calls = stubFetch(({ url }) =>
      url.endsWith("/handoff")
        ? Response.json({ error: "Session not found" }, { status: 404 })
        : Response.json({ sessionId: "session-2", forkedFromSessionId: "session-1", created: true })
    );
    render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Session not found Write a prompt yourself, leave it empty to let the server draft one, or retry."
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(postedBodies(calls)[0]).not.toHaveProperty("handoff");
  });

  it("retries loading the draft", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : Response.json({ handoff: "Second draft" });
    });
    render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(screen.getByDisplayValue("Second draft")).toBeInTheDocument());
  });
});
