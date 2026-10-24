// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { NotificationSettings } from "@open-inspect/shared/types/integrations";
import {
  NotificationsIntegrationSettings,
  noticeMode,
  noticeSettingsFor,
} from "./notifications-integration-settings";

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

vi.mock("swr", () => ({ default: useSWRMock, mutate: mutateMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.fn();
const KEY = "/api/integration-settings/notifications";

function setupSWR(defaults: NotificationSettings | null) {
  useSWRMock.mockImplementation((key: string) =>
    key === KEY
      ? { data: { settings: defaults === null ? null : { defaults } }, isLoading: false }
      : { data: undefined, isLoading: false }
  );
}

function savedBody() {
  const [, init] = fetchMock.mock.calls.find(([url, i]) => url === KEY && i?.method === "PUT")!;
  return JSON.parse(init.body);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  useSWRMock.mockReset();
  allowedPermissions.value = null;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("noticeMode", () => {
  it("reads nothing stored, a disabled entry and an enabled one", () => {
    expect(noticeMode(undefined)).toBe("off");
    expect(noticeMode({ enabled: false, mode: "live" })).toBe("off");
    expect(noticeMode({ enabled: true, mode: "shadow" })).toBe("shadow");
    expect(noticeMode({ enabled: true })).toBe("off");
  });

  it("round-trips through the stored shape", () => {
    expect(noticeSettingsFor("off", {})).toEqual({ enabled: false });
    expect(noticeSettingsFor("live", { skipMotionSessions: false })).toEqual({
      enabled: true,
      mode: "live",
      skipMotionSessions: false,
    });
  });
});

describe("session notices settings", () => {
  it("saves shadow mode with the channel defaults", async () => {
    const user = userEvent.setup();
    setupSWR(null);

    render(<NotificationsIntegrationSettings />);

    expect(screen.getByRole("radio", { name: /^off/i })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /^shadow/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(savedBody()).toEqual({
      settings: {
        defaults: {
          enabled: true,
          mode: "shadow",
          channels: { teams: true },
          skipMotionSessions: true,
        },
      },
    });
  });

  it("asks before going live and saves only on confirm", async () => {
    const user = userEvent.setup();
    setupSWR({ enabled: true, mode: "shadow" });

    render(<NotificationsIntegrationSettings />);

    await user.click(screen.getByRole("radio", { name: /^live/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /go live/i }));
    expect(savedBody().settings.defaults).toMatchObject({ enabled: true, mode: "live" });
  });

  it("does not ask again when it is already live", async () => {
    const user = userEvent.setup();
    setupSWR({ enabled: true, mode: "live" });

    render(<NotificationsIntegrationSettings />);

    await user.click(screen.getByRole("switch", { name: /leave motion sessions/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(savedBody().settings.defaults).toMatchObject({
      mode: "live",
      skipMotionSessions: false,
    });
  });

  it("turning off stores enabled false", async () => {
    const user = userEvent.setup();
    setupSWR({ enabled: true, mode: "live" });

    render(<NotificationsIntegrationSettings />);

    await user.click(screen.getByRole("radio", { name: /^off/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(savedBody().settings.defaults).toEqual({
      enabled: false,
      channels: { teams: true },
      skipMotionSessions: true,
    });
  });

  it("is read-only without integrations.manage", () => {
    setupSWR({ enabled: true, mode: "shadow" });
    allowedPermissions.value = new Set(["integrations.read"]);

    render(<NotificationsIntegrationSettings />);

    expect(screen.getByRole("radio", { name: /^live/i })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /teams message/i })).toBeDisabled();
  });
});
