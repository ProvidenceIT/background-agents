// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { SessionToolsIntegrationSettings } from "./session-tools-integration-settings";

const allowedPermissions = vi.hoisted(() => ({ value: null as Set<string> | null }));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      allowedPermissions.value === null || allowedPermissions.value.has(permission),
  }),
}));

expect.extend(matchers);

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: mutateMock,
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const fetchMock = vi.fn();
const nestedRepo = "group/subgroup/web";

interface ToolSettings {
  tools?: string[];
}

interface RepoSettingsEntry {
  repo: string;
  settings: ToolSettings;
}

function setupSWR(
  integrationId: string,
  opts: {
    global?: { defaults?: ToolSettings; enabledRepos?: string[] } | null;
    repos?: RepoSettingsEntry[];
    availableRepos?: EnrichedRepository[];
  }
) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === `/api/integration-settings/${integrationId}`) {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: false,
      };
    }
    if (key === `/api/integration-settings/${integrationId}/repos`) {
      return { data: { repos: opts.repos ?? [] }, isLoading: false };
    }
    if (key === "/api/repos") {
      return { data: { repos: opts.availableRepos ?? [] }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

function repo(fullName: string): EnrichedRepository {
  return {
    fullName,
    private: false,
    description: null,
    htmlUrl: `https://gitlab.example/${fullName}`,
    defaultBranch: "main",
  } as unknown as EnrichedRepository;
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

function overrideRow(fullName: string) {
  return screen.getByRole("group", { name: `${fullName} override` });
}

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  fetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  mutateMock.mockReset();
  useSWRMock.mockReset();
  allowedPermissions.value = null;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session tools integration settings", () => {
  const id = "session-tools";

  it("saves the default tool list in gate order", async () => {
    const user = userEvent.setup();
    setupSWR(id, { global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SessionToolsIntegrationSettings />);

    await user.click(screen.getByRole("checkbox", { name: /^add a note to the motion task/i }));
    await user.click(screen.getByRole("checkbox", { name: /^notify the owner/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { defaults: { tools: ["notify", "motion_write"] } } }),
      })
    );
  });

  it("shows the stored tools and turns one off", async () => {
    const user = userEvent.setup();
    setupSWR(id, {
      global: { defaults: { tools: ["notify", "motion_read", "motion_write"] } },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SessionToolsIntegrationSettings />);

    const read = screen.getByRole("checkbox", { name: /^read the motion task/i });
    expect(read).toBeChecked();
    await user.click(read);
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}`,
      expect.objectContaining({
        body: JSON.stringify({ settings: { defaults: { tools: ["notify", "motion_write"] } } }),
      })
    );
  });

  it("adds a repository override with no tools, then gives it one", async () => {
    const user = userEvent.setup();
    setupSWR(id, { global: null, availableRepos: [repo(nestedRepo)] });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SessionToolsIntegrationSettings />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: nestedRepo }));
    await user.click(screen.getByRole("button", { name: /add override/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}/repos/group%2Fsubgroup/web`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { tools: [] } }),
      })
    );
  });

  it("saves an override's own tool list", async () => {
    const user = userEvent.setup();
    setupSWR(id, { global: null, repos: [{ repo: nestedRepo, settings: { tools: ["notify"] } }] });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SessionToolsIntegrationSettings />);

    const row = within(overrideRow(nestedRepo));
    expect(row.getByRole("checkbox", { name: /notify the owner/i })).toBeChecked();
    await user.click(row.getByRole("checkbox", { name: /read the motion task/i }));
    await user.click(row.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}/repos/group%2Fsubgroup/web`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { tools: ["notify", "motion_read"] } }),
      })
    );
  });

  it("is read-only without integrations.manage", () => {
    setupSWR(id, { global: { defaults: { tools: ["notify"] } } });
    allowedPermissions.value = new Set(["integrations.read"]);

    render(<SessionToolsIntegrationSettings />);

    expect(screen.getByRole("checkbox", { name: /^notify the owner/i })).toBeDisabled();
  });
});
