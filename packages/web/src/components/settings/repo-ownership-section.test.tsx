// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { RepoOwnership } from "@open-inspect/shared/types/repo-ownership";
import { codeownersSyncLabel, RepoOwnershipSection } from "./repo-ownership-section";

expect.extend(matchers);

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));
vi.mock("swr", () => ({ default: useSWRMock, mutate: mutateMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
const SYNCED_AT = Date.UTC(2026, 9, 24, 3);

const PILOT: RepoOwnership = {
  repo: "providenceit/background-agents",
  ownerTeam: { id: "team-platform", slug: "platform", name: "Platform" },
  tier: "T1",
  repoClass: "internal",
  effectiveRepoClass: "internal",
  domain: null,
  dependsOn: null,
  codeowners: [{ pattern: "*", owners: [{ kind: "team", handle: "@ProvidenceIT/platform" }] }],
  codeownersSyncedAt: SYNCED_AT,
};

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  mutateMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useSWRMock.mockReset();
  useSWRMock.mockImplementation((key: string | null) => {
    if (key === "/api/repo-ownership") return { data: { repos: [PILOT] } };
    if (key === "/api/teams") {
      return {
        data: {
          teams: [
            { id: "team-platform", slug: "platform", name: "Platform", archivedAt: null },
            { id: "team-web", slug: "web", name: "Web", archivedAt: null },
          ],
        },
      };
    }
    return { data: undefined };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("codeownersSyncLabel", () => {
  it("tells apart never synced, no file and a synced file", () => {
    expect(codeownersSyncLabel({ ...PILOT, codeownersSyncedAt: null })).toBe(
      "CODEOWNERS not synced yet"
    );
    expect(codeownersSyncLabel({ ...PILOT, codeowners: null })).toMatch(
      /^No CODEOWNERS file \(checked .+\)$/
    );
    expect(codeownersSyncLabel(PILOT)).toMatch(/^CODEOWNERS synced .+2026/);
  });
});

describe("RepoOwnershipSection", () => {
  it("shows owner, tier, class and the CODEOWNERS sync time read-only without the permission", () => {
    render(<RepoOwnershipSection canManage={false} availableRepos={[]} />);

    expect(screen.getByText("providenceit/background-agents")).toBeInTheDocument();
    expect(screen.getByText(/^Platform · T1 · Internal · CODEOWNERS synced/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(useSWRMock).toHaveBeenCalledWith(null);
  });

  it("saves an edited class with every ownership field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(Response.json({ ownership: PILOT }));
    render(<RepoOwnershipSection canManage availableRepos={[]} />);

    await user.click(
      screen.getByRole("combobox", { name: "Class for providenceit/background-agents" })
    );
    await user.click(within(screen.getByRole("listbox")).getByText("Playground"));
    await user.type(
      screen.getByRole("textbox", { name: "Domain for providenceit/background-agents" }),
      "factory"
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/repos/providenceit/background-agents/ownership");
    expect(init).toMatchObject({ method: "PUT" });
    expect(JSON.parse(init.body)).toEqual({
      ownerTeamId: "team-platform",
      tier: "T1",
      repoClass: "playground",
      domain: "factory",
      dependsOn: null,
    });
    expect(mutateMock).toHaveBeenCalledWith("/api/repo-ownership");
  });
});
