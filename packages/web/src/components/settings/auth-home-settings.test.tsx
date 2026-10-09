// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import type { AuthHome, SubscriptionSharing } from "@open-inspect/shared/types/auth-homes";
import { AuthHomeSettings } from "./auth-home-settings";

expect.extend(matchers);
afterEach(cleanup);

const DAY_MS = 86_400_000;
let viewerUserId: string;
let permissions: Set<string>;
let home: AuthHome | null;
let sharing: SubscriptionSharing;
let requests: { method: string; path: string; body: unknown }[];

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: viewerUserId } }, status: "authenticated" }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permissions.has(permission),
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const MEMBER = ["auth_homes.manage_own", "sessions.create"];
const OWNER = [...MEMBER, "auth_homes.read_all", "subscription_sharing.manage"];

function homeFixture(overrides: Partial<AuthHome> = {}): AuthHome {
  return {
    id: "ah_1",
    ownerUserIds: ["user-owner"],
    pvcName: "sf-home-bram",
    nodeName: "sandbox-node-1",
    providers: ["anthropic", "openai"],
    kindsEnabled: ["prompt", "child", "mention", "issue_label", "pr_event", "schedule"],
    backgroundConsentAt: null,
    maxConcurrent: 3,
    shared: false,
    sharingConsentAt: null,
    status: "active",
    claudeExpiresAt: null,
    registeredAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function respond(method: string, path: string, body: unknown): Response {
  if (path === "/api/me/auth-home") {
    if (method === "GET") {
      return home
        ? Response.json({ home })
        : Response.json({ error: "No subscription home is registered for you" }, { status: 404 });
    }
    if (method === "PUT") {
      const request = body as Record<string, unknown>;
      home = homeFixture({
        ...home,
        shared: request.shared as boolean,
        sharingConsentAt: request.shared ? 5 : null,
        updatedAt: 5,
      });
      return Response.json({ home });
    }
  }
  if (path === "/api/subscription-sharing") {
    if (method === "PUT") {
      sharing = {
        policy: (body as SubscriptionSharing).policy,
        updatedBy: viewerUserId,
        updatedAt: 5,
      };
    }
    return Response.json(sharing);
  }
  if (path === "/api/auth-homes") {
    const { pvcName: _pvcName, ...metadata } = homeFixture();
    return Response.json({ homes: [metadata] });
  }
  return Response.json({ error: "unexpected" }, { status: 500 });
}

function renderSettings() {
  return render(<AuthHomeSettings />, {
    wrapper: ({ children }) => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    ),
  });
}

describe("AuthHomeSettings", () => {
  beforeEach(() => {
    viewerUserId = "user-owner";
    permissions = new Set(MEMBER);
    home = homeFixture();
    sharing = { policy: "household", updatedBy: null, updatedAt: null };
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, path: input, body });
        return respond(method, input, body);
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the caller's home with its providers, the token expiry and all six kinds on", async () => {
    const expiresAt = Date.now() + 10 * DAY_MS + 60_000;
    home = homeFixture({ claudeExpiresAt: expiresAt });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Your home" })).toBeInTheDocument();
    expect(screen.getByText("Claude, ChatGPT (Codex)")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      `Claude token expires on ${new Date(expiresAt).toISOString().slice(0, 10)}, in 10 days.`
    );
    for (const label of [
      "Your own prompts",
      "Child sessions",
      "Teams mentions",
      "Issue labels",
      "Pull request events",
      "Scheduled automations",
    ]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    }
    expect(
      screen.getByRole("checkbox", { name: /I consent to background use of my home/ })
    ).toHaveAccessibleName(expect.stringContaining("Obtain express consent before background use"));
  });

  it("keeps the sharing switch disabled for a viewer who is not the home's owner", async () => {
    viewerUserId = "user-merged";
    home = homeFixture({ ownerUserIds: ["user-owner", "user-merged"] });
    renderSettings();

    const share = await screen.findByRole("switch", { name: "Share with enrolled colleagues" });
    expect(share).toBeDisabled();
    expect(
      screen.getByText("Only the home's owner can change whether it is shared.")
    ).toBeVisible();
  });

  it("asks the owner to confirm against the providers' sharing clauses, then sends shared:true", async () => {
    renderSettings();
    const share = await screen.findByRole("switch", { name: "Share with enrolled colleagues" });
    expect(share).toBeEnabled();

    fireEvent.click(share);
    const dialog = await screen.findByRole("alertdialog");
    for (const text of [
      "make your Account available to anyone else",
      "Using one user's subscription to fulfill another user's requests",
      "colleagues",
      "risk acceptance recorded 2026-10-09",
    ]) {
      expect(dialog).toHaveTextContent(text);
    }
    expect(requests.filter((request) => request.method === "PUT")).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Share my home" }));
    await waitFor(() =>
      expect(requests.filter((request) => request.method === "PUT")).toEqual([
        {
          method: "PUT",
          path: "/api/me/auth-home",
          body: {
            pvcName: "sf-home-bram",
            nodeName: "sandbox-node-1",
            providers: ["anthropic", "openai"],
            kindsEnabled: ["prompt", "child", "mention", "issue_label", "pr_event", "schedule"],
            backgroundConsent: false,
            maxConcurrent: 3,
            shared: true,
            status: "active",
          },
        },
      ])
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Share with enrolled colleagues" })).toBeChecked()
    );
  });

  it("hides the workspace switch from a Member and shows the policy read-only", async () => {
    renderSettings();
    expect(
      await screen.findByText(/Workspace policy: Household\./, { exact: false })
    ).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Enrolled homes" })).not.toBeInTheDocument();
    expect(requests.map((request) => request.path)).not.toContain("/api/auth-homes");
  });

  it("lets an Owner switch the workspace to owner_only directly and back to household after confirming", async () => {
    permissions = new Set(OWNER);
    renderSettings();

    const group = await screen.findByRole("radiogroup", { name: "Workspace sharing policy" });
    expect(await screen.findByRole("heading", { name: "Enrolled homes" })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("radio", { name: /Owner only/ }));
    await waitFor(() =>
      expect(requests.filter((request) => request.method === "PUT")).toEqual([
        { method: "PUT", path: "/api/subscription-sharing", body: { policy: "owner_only" } },
      ])
    );
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: /Owner only/ })).toBeChecked()
    );

    fireEvent.click(within(group).getByRole("radio", { name: /Household/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("risk acceptance recorded 2026-10-09");
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch to household" }));
    await waitFor(() =>
      expect(requests.filter((request) => request.method === "PUT").at(-1)).toEqual({
        method: "PUT",
        path: "/api/subscription-sharing",
        body: { policy: "household" },
      })
    );
  });

  it("offers registration when no home is registered for the caller", async () => {
    home = null;
    renderSettings();
    expect(
      await screen.findByRole("heading", { name: "No home is registered for you" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeDisabled();
  });
});
