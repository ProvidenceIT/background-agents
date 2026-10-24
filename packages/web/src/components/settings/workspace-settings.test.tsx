// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useWorkspaceAdministration } from "@/hooks/use-workspace-administration";
import { WorkspaceSettings } from "./workspace-settings";

expect.extend(matchers);

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: vi.fn(),
}));
vi.mock("@/hooks/use-workspace-administration", () => ({
  useWorkspaceAdministration: vi.fn(),
}));
const VIEWER_ID = "99999999999999999999999999999999";
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: VIEWER_ID } }, status: "authenticated" }),
}));

const ADMIN_PERMISSIONS = new Set([
  "workspace.members.read",
  "workspace.roles.read",
  "workspace.members.manage",
  "workspace.transfer_ownership",
]);
const ROLES = [
  {
    id: "role_builtin_owner",
    key: "owner" as const,
    name: "Owner",
    description: null,
    permissions: [],
    assignmentCount: 1,
  },
  {
    id: "role_builtin_administrator",
    key: "administrator" as const,
    name: "Administrator",
    description: null,
    permissions: [],
    assignmentCount: 1,
  },
  {
    id: "role_builtin_member",
    key: "member" as const,
    name: "Member",
    description: null,
    permissions: [],
    assignmentCount: 1,
  },
];
const viewer = {
  userId: VIEWER_ID,
  displayName: "Grace",
  email: "grace@example.com",
  suspendedAt: null,
  role: { id: "role_builtin_administrator", key: "administrator" as const, name: "Administrator" },
};
const colleague = {
  userId: "11111111111111111111111111111111",
  displayName: "Ada",
  email: "ada@example.com",
  suspendedAt: null,
  role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
};

function renderAsAdministrator(updateMember = vi.fn().mockResolvedValue(undefined)) {
  vi.mocked(useCurrentUserAuthorization).mockReturnValue({
    authorization: null,
    loading: false,
    error: null,
    hasPermission: (permission) => ADMIN_PERMISSIONS.has(permission),
  });
  vi.mocked(useWorkspaceAdministration).mockReturnValue({
    members: [viewer, colleague],
    roles: ROLES,
    loading: false,
    error: undefined,
    updateMember,
  });
  render(<WorkspaceSettings />);
  return updateMember;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSettings", () => {
  it("marks only the signed-in member's row as You", () => {
    renderAsAdministrator();

    expect(screen.getAllByText("You")).toHaveLength(1);
    expect(screen.getByText("Grace")).toContainElement(screen.getByText("You"));
    expect(screen.getByText("Ada")).not.toContainElement(screen.getByText("You"));
  });

  it("holds self-suspension until the user types their name, then sends confirm", async () => {
    const user = userEvent.setup();
    const updateMember = renderAsAdministrator();

    await user.click(screen.getAllByRole("button", { name: "Suspend" })[0]);

    const dialog = await screen.findByRole("alertdialog", { name: "Suspend yourself?" });
    expect(dialog).toHaveTextContent("You will be signed out at once");
    expect(updateMember).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Suspend me" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Type Grace to confirm."), "Grace");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() =>
      expect(updateMember).toHaveBeenCalledWith(viewer, {
        kind: "status",
        suspended: true,
        confirm: true,
      })
    );
  });

  it("suspends another member without a confirmation", async () => {
    const user = userEvent.setup();
    const updateMember = renderAsAdministrator();

    await user.click(screen.getAllByRole("button", { name: "Suspend" })[1]);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateMember).toHaveBeenCalledWith(colleague, { kind: "status", suspended: true });
  });

  it("asks for a typed confirmation before making someone an Owner", async () => {
    const user = userEvent.setup();
    const updateMember = renderAsAdministrator();

    await user.click(screen.getByRole("combobox", { name: "Role for Ada" }));
    await user.click(await screen.findByRole("option", { name: "Owner" }));

    expect(await screen.findByRole("alertdialog", { name: "Make Ada an Owner?" })).toBeVisible();
    expect(updateMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(updateMember).not.toHaveBeenCalled();
  });

  it("shows assigned role names to members-only readers", () => {
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) => permission === "workspace.members.read",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [
        {
          userId: "11111111111111111111111111111111",
          displayName: "Ada",
          email: "ada@example.com",
          suspendedAt: null,
          role: { id: "role_release", key: null, name: "Release Managers" },
        },
      ],
      roles: [],
      loading: false,
      error: undefined,
      updateMember: vi.fn(),
    });

    render(<WorkspaceSettings />);

    expect(screen.getByText("Release Managers")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("does not offer destructive controls for the sole unsuspended Owner", () => {
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" ||
        permission === "workspace.roles.read" ||
        permission === "workspace.members.manage" ||
        permission === "workspace.transfer_ownership",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [
        {
          userId: "11111111111111111111111111111111",
          displayName: "Owner",
          email: "owner@example.com",
          suspendedAt: null,
          role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
        },
      ],
      roles: [
        {
          id: "role_builtin_owner",
          key: "owner",
          name: "Owner",
          description: null,
          permissions: [],
          assignmentCount: 1,
        },
      ],
      loading: false,
      error: undefined,
      updateMember: vi.fn(),
    });

    render(<WorkspaceSettings />);

    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
  });

  it("restores a suspended member through the boolean status contract", async () => {
    const updateMember = vi.fn().mockResolvedValue(undefined);
    const member = {
      userId: "11111111111111111111111111111111",
      displayName: "Ada",
      email: "ada@example.com",
      suspendedAt: 100,
      role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
    };
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" || permission === "workspace.members.manage",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [member],
      roles: [],
      loading: false,
      error: undefined,
      updateMember,
    });

    render(<WorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(updateMember).toHaveBeenCalledWith(member, { kind: "status", suspended: false })
    );
  });

  it("disables a member's role and status controls while their update is pending", async () => {
    const user = userEvent.setup();
    let finishUpdate!: () => void;
    const updateMember = vi.fn(() => new Promise<void>((resolve) => (finishUpdate = resolve)));
    const member = {
      userId: "11111111111111111111111111111111",
      displayName: "Ada",
      email: "ada@example.com",
      suspendedAt: null,
      role: { id: "role_builtin_member", key: "member" as const, name: "Member" },
    };
    vi.mocked(useCurrentUserAuthorization).mockReturnValue({
      authorization: null,
      loading: false,
      error: null,
      hasPermission: (permission) =>
        permission === "workspace.members.read" ||
        permission === "workspace.roles.read" ||
        permission === "workspace.members.manage",
    });
    vi.mocked(useWorkspaceAdministration).mockReturnValue({
      members: [member],
      roles: [
        {
          id: "role_builtin_member",
          key: "member",
          name: "Member",
          description: null,
          permissions: [],
          assignmentCount: 1,
        },
        {
          id: "role_builtin_administrator",
          key: "administrator",
          name: "Administrator",
          description: null,
          permissions: [],
          assignmentCount: 0,
        },
      ],
      loading: false,
      error: undefined,
      updateMember,
    });

    render(<WorkspaceSettings />);
    await user.click(screen.getByRole("combobox", { name: "Role for Ada" }));
    await user.click(await screen.findByRole("option", { name: "Administrator" }));

    expect(updateMember).toHaveBeenCalledWith(member, {
      kind: "role",
      roleId: "role_builtin_administrator",
    });
    await waitFor(() => expect(screen.getByRole("combobox")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();

    finishUpdate();
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  });
});
