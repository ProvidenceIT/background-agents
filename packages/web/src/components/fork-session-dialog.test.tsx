// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import type { ForkSubscriptionSlot } from "@open-inspect/shared/types/session-api";
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

/** Subscription-slot lookups the dialog made, kept apart from the handoff and fork calls. */
let slotCalls: string[] = [];

/**
 * Answers the dialog's requests; subscription-slot lookups get `slots` (none by default) and
 * are recorded in `slotCalls`, not in the returned calls.
 */
function stubFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
  slots: ForkSubscriptionSlot[] | Response = []
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/fork/subscription-slots")) {
        slotCalls.push(url);
        const harness = new URL(url, "http://localhost").searchParams.get("harness");
        return slots instanceof Response ? slots : Response.json({ harness, slots });
      }
      const call = { url, init };
      calls.push(call);
      return respond(call);
    })
  );
  return calls;
}

function slot(name: string, percentRemaining: number | null = null): ForkSubscriptionSlot {
  return { slot: name, percentRemaining, lastUsedAt: null };
}

function postedBodies(calls: FetchCall[]) {
  return calls
    .filter((call) => call.init?.method === "POST")
    .map((call) => JSON.parse(call.init?.body as string));
}

beforeEach(() => {
  push.mockReset();
  slotCalls = [];
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

  it("starts a legacy OpenCode session on an Anthropic model on Claude Agent, keeping its model", async () => {
    const calls = stubFetch(({ url }) =>
      url.endsWith("/handoff")
        ? Response.json({ handoff: "Draft" })
        : Response.json({ sessionId: "session-4", forkedFromSessionId: "session-1", created: true })
    );
    render(
      <ForkSessionDialog open onOpenChange={vi.fn()} source={{ ...SOURCE, harness: "opencode" }} />
    );
    await screen.findByDisplayValue("Draft");

    expect(screen.getByTestId("agent")).toHaveTextContent("claude anthropic/claude-opus-5");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(postedBodies(calls)[0]).toMatchObject({
      harness: "claude",
      model: "anthropic/claude-opus-5",
    });
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
  it("stays open on Escape or an outside click while the fork is being created", async () => {
    let finish: (response: Response) => void = () => {};
    stubFetch(({ url }) =>
      url.endsWith("/handoff")
        ? Response.json({ handoff: "Draft" })
        : new Promise<Response>((resolve) => {
            finish = resolve;
          })
    );
    const onOpenChange = vi.fn();
    render(<ForkSessionDialog open onOpenChange={onOpenChange} source={SOURCE} />);
    await screen.findByDisplayValue("Draft");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
    fireEvent.click(document.body);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await act(async () => {
      finish(
        Response.json({ sessionId: "session-2", forkedFromSessionId: "session-1", created: true })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/session/session-2");
  });

  it("closes on Escape when no fork is being created", async () => {
    stubFetch(() => Response.json({ handoff: "Draft" }));
    const onOpenChange = vi.fn();
    render(<ForkSessionDialog open onOpenChange={onOpenChange} source={SOURCE} />);
    await screen.findByDisplayValue("Draft");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  describe("subscription", () => {
    function forkResponds({ url }: FetchCall) {
      return url.endsWith("/handoff")
        ? Response.json({ handoff: "Draft" })
        : Response.json(
            { sessionId: "session-2", forkedFromSessionId: "session-1", created: true },
            { status: 201 }
          );
    }

    it("forks onto the chosen slot", async () => {
      const user = userEvent.setup();
      const calls = stubFetch(forkResponds, [slot("claude-1", 12), slot("claude-2")]);
      render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
      await screen.findByDisplayValue("Draft");

      const select = await screen.findByRole("combobox", { name: "Subscription" });
      expect(select).toHaveTextContent("Automatic (most headroom)");
      expect(slotCalls).toEqual(["/api/sessions/session-1/fork/subscription-slots?harness=claude"]);

      await user.click(select);
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Automatic (most headroom)",
        "claude-1 (12%)",
        "claude-2",
      ]);
      await user.click(screen.getByRole("option", { name: "claude-2" }));
      expect(select).toHaveTextContent("claude-2");
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(postedBodies(calls)[0]).toEqual({
        forkRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        harness: "claude",
        model: "anthropic/claude-opus-5",
        reasoningEffort: "high",
        handoff: "Draft",
        subscriptionSlot: "claude-2",
      });
    });

    it("marks the slot that hit the source's limit and warns when it is chosen", async () => {
      const user = userEvent.setup();
      const calls = stubFetch(forkResponds, [slot("claude-1"), slot("claude-3"), slot("claude-5")]);
      render(
        <ForkSessionDialog
          open
          onOpenChange={vi.fn()}
          source={{ ...SOURCE, limitedSlot: "claude-3" }}
        />
      );
      await screen.findByDisplayValue("Draft");

      const select = await screen.findByRole("combobox", { name: "Subscription" });
      await user.click(select);
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Automatic (most headroom)",
        "claude-1",
        "claude-3 (limit reached)",
        "claude-5",
      ]);
      expect(screen.queryByText(/hit its limit/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("option", { name: "claude-3 (limit reached)" }));
      expect(
        screen.getByText(
          "claude-3 hit this session's limit. Until it resets, the fork falls back to the automatic pick."
        )
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(postedBodies(calls)[0]).toMatchObject({ subscriptionSlot: "claude-3" });
    });

    it("sends no slot when Automatic stays chosen", async () => {
      const calls = stubFetch(forkResponds, [slot("claude-1"), slot("claude-2")]);
      render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
      await screen.findByRole("combobox", { name: "Subscription" });
      await screen.findByDisplayValue("Draft");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      expect(postedBodies(calls)[0]).not.toHaveProperty("subscriptionSlot");
    });

    it("offers no choice for a single slot", async () => {
      stubFetch(forkResponds, [slot("claude-1", 80)]);
      render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
      await screen.findByDisplayValue("Draft");
      await waitFor(() => expect(slotCalls).toHaveLength(1));

      expect(screen.queryByRole("combobox", { name: "Subscription" })).not.toBeInTheDocument();
    });

    it("offers no choice when the slots cannot be loaded", async () => {
      const calls = stubFetch(forkResponds, Response.json({ error: "Forbidden" }, { status: 403 }));
      render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
      await screen.findByDisplayValue("Draft");
      await waitFor(() => expect(slotCalls).toHaveLength(1));

      expect(screen.queryByRole("combobox", { name: "Subscription" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });
      expect(postedBodies(calls)[0]).not.toHaveProperty("subscriptionSlot");
    });

    it("drops the choice and the select when the fork moves to another agent", async () => {
      const user = userEvent.setup();
      const calls = stubFetch(forkResponds, [slot("claude-1"), slot("claude-2")]);
      render(<ForkSessionDialog open onOpenChange={vi.fn()} source={SOURCE} />);
      await screen.findByDisplayValue("Draft");
      await user.click(await screen.findByRole("combobox", { name: "Subscription" }));
      await user.click(screen.getByRole("option", { name: "claude-1" }));

      await user.click(screen.getByRole("button", { name: "Switch agent to codex" }));

      expect(screen.queryByRole("combobox", { name: "Subscription" })).not.toBeInTheDocument();
      expect(slotCalls).toEqual(["/api/sessions/session-1/fork/subscription-slots?harness=claude"]);
      await user.click(screen.getByRole("button", { name: "Create" }));
      expect(postedBodies(calls)[0]).toMatchObject({ harness: "codex" });
      expect(postedBodies(calls)[0]).not.toHaveProperty("subscriptionSlot");
    });

    it("shows a refused slot as an error and keeps the dialog open", async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      stubFetch(
        ({ url }) =>
          url.endsWith("/handoff")
            ? Response.json({ handoff: "Draft" })
            : Response.json(
                { error: "Subscription slot unavailable", code: "subscription_slot_unavailable" },
                { status: 400 }
              ),
        [slot("claude-1"), slot("claude-2")]
      );
      render(<ForkSessionDialog open onOpenChange={onOpenChange} source={SOURCE} />);
      await screen.findByDisplayValue("Draft");
      await user.click(await screen.findByRole("combobox", { name: "Subscription" }));
      await user.click(screen.getByRole("option", { name: "claude-2" }));

      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(screen.getByRole("alert")).toHaveTextContent(
        "That subscription is not available for this fork. Choose another one or Automatic."
      );
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(screen.getByRole("combobox", { name: "Subscription" })).toBeEnabled();
    });
  });
});
