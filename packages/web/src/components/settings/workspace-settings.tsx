"use client";

import { useState } from "react";
import type { RoleSummary, WorkspaceMember } from "@open-inspect/shared/rbac";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import {
  useWorkspaceAdministration,
  type WorkspaceMemberAction,
} from "@/hooks/use-workspace-administration";
import { useAuthSession } from "@/lib/auth-session";

/** A change that can cost someone their access, held until the user types the name. */
interface RiskyChange {
  member: WorkspaceMember;
  action: WorkspaceMemberAction;
  title: string;
  consequence: string;
  confirmLabel: string;
}

function memberName(member: WorkspaceMember): string {
  return member.displayName ?? member.email ?? member.userId;
}

/**
 * Self-suspension, any change to your own role, and making someone an Owner
 * need a typed confirmation. Other changes apply at once.
 */
function riskyChange(
  member: WorkspaceMember,
  action: WorkspaceMemberAction,
  viewerId: string | undefined,
  roles: readonly RoleSummary[]
): RiskyChange | null {
  const self = member.userId === viewerId;
  if (action.kind === "status") {
    if (!self || !action.suspended) return null;
    return {
      member,
      action,
      title: "Suspend yourself?",
      consequence:
        "You will be signed out at once and cannot sign back in. Only another Owner or Administrator can restore your access.",
      confirmLabel: "Suspend me",
    };
  }
  const role = roles.find(({ id }) => id === action.roleId);
  if (self) {
    return {
      member,
      action,
      title: `Change your role to ${role?.name ?? action.roleId}?`,
      consequence: `You lose the permissions of ${member.role.name} right away. Only an Owner or Administrator can give them back.`,
      confirmLabel: "Change my role",
    };
  }
  if (role?.key === "owner") {
    return {
      member,
      action,
      title: `Make ${memberName(member)} an Owner?`,
      consequence: `${memberName(member)} will be able to manage every member and role, including yours, and transfer ownership.`,
      confirmLabel: "Make Owner",
    };
  }
  return null;
}

/**
 * Shows workspace members and roles, exposing member controls only when the user may manage them.
 */
export function WorkspaceSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canReadMembers = hasPermission("workspace.members.read");
  const canReadRoles = hasPermission("workspace.roles.read");
  const canManage = hasPermission("workspace.members.manage");
  const canAssignRoles = canManage && canReadRoles;
  const canTransfer = hasPermission("workspace.transfer_ownership");
  const viewerId = useAuthSession().data?.user?.id;
  const { members, roles, loading, error, updateMember } = useWorkspaceAdministration({
    readMembers: canReadMembers,
    readRoles: canReadRoles,
  });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState<RiskyChange | null>(null);
  const [typedName, setTypedName] = useState("");
  const unsuspendedOwnerCount = members.filter(
    (member) => member.role.key === "owner" && member.suspendedAt === null
  ).length;

  if (loading) return <p className="text-sm text-muted-foreground">Loading workspace access...</p>;
  if (error) return <ErrorBanner>Failed to load workspace access.</ErrorBanner>;

  function request(member: WorkspaceMember, action: WorkspaceMemberAction) {
    const risky = riskyChange(member, action, viewerId, roles);
    if (risky) {
      setTypedName("");
      setConfirming(risky);
      return;
    }
    void mutate(member.userId, () => updateMember(member, action));
  }

  function confirmRiskyChange() {
    if (!confirming) return;
    const { member, action } = confirming;
    setConfirming(null);
    void mutate(member.userId, () => updateMember(member, { ...action, confirm: true }));
  }

  async function mutate(memberId: string, action: () => Promise<void>) {
    setMutationError(null);
    setPendingMemberIds((current) => new Set(current).add(memberId));
    try {
      await action();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Workspace update failed");
    } finally {
      setPendingMemberIds((current) => {
        const next = new Set(current);
        next.delete(memberId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Workspace access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign one role to each canonical user. Backend authorization remains authoritative.
        </p>
      </div>

      {mutationError && <ErrorBanner>{mutationError}</ErrorBanner>}

      {canReadMembers && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Members
          </h3>
          <div className="divide-y divide-border rounded-lg border border-border">
            {members.map((member) => (
              <div
                key={member.userId}
                className="grid gap-3 p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {memberName(member)}
                    {member.userId === viewerId && (
                      <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        You
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email ?? member.userId}
                  </p>
                </div>
                {canAssignRoles &&
                (member.role.key !== "owner" ||
                  (canTransfer &&
                    !(member.suspendedAt === null && unsuspendedOwnerCount === 1))) ? (
                  <Select
                    value={member.role.id}
                    disabled={pendingMemberIds.has(member.userId)}
                    onValueChange={(roleId) => request(member, { kind: "role", roleId })}
                  >
                    <SelectTrigger aria-label={`Role for ${member.displayName ?? member.userId}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roles
                        .filter(
                          (role) =>
                            role.key !== "owner" || canTransfer || role.id === member.role.id
                        )
                        .map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-sm text-foreground">{member.role.name}</span>
                )}
                <Button
                  variant="outline"
                  disabled={
                    !canManage ||
                    pendingMemberIds.has(member.userId) ||
                    (member.role.key === "owner" &&
                      (!canTransfer ||
                        (member.suspendedAt === null && unsuspendedOwnerCount === 1)))
                  }
                  onClick={() =>
                    request(member, { kind: "status", suspended: member.suspendedAt === null })
                  }
                >
                  {member.suspendedAt === null ? "Suspend" : "Restore"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirming && (
            <div className="space-y-2">
              <label htmlFor="confirm-member-name" className="text-sm text-foreground">
                Type <span className="font-medium">{memberName(confirming.member)}</span> to
                confirm.
              </label>
              <Input
                id="confirm-member-name"
                value={typedName}
                autoComplete="off"
                onChange={(event) => setTypedName(event.target.value)}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!confirming || typedName.trim() !== memberName(confirming.member)}
              onClick={(event) => {
                event.preventDefault();
                confirmRiskyChange();
              }}
            >
              {confirming?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canReadRoles && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Roles
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.map((role) => (
              <article key={role.id} className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="font-medium text-foreground">{role.name}</h4>
                  <span className="text-xs text-muted-foreground">
                    {role.assignmentCount} assigned
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {role.description ?? `${role.permissions.length} permissions`}
                </p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
