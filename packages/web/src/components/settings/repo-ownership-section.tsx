"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  REPO_CLASSES,
  REPO_TIERS,
  repoOwnershipListResponseSchema,
  type RepoClass,
  type RepoOwnership,
  type RepoOwnershipInput,
  type RepoTier,
} from "@open-inspect/shared/types/repo-ownership";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsCardSection } from "./settings-card-section";

const REPO_OWNERSHIP_KEY = "/api/repo-ownership";
const NONE = "none";

interface TeamOption {
  id: string;
  slug: string;
  name: string;
  archivedAt: number | null;
}

const CLASS_LABELS: Record<RepoClass, string> = {
  playground: "Playground",
  internal: "Internal",
  client: "Client",
};

function ownershipPath(fullName: string): `/api/${string}` | null {
  const repository = parseRepositoryFullName(fullName);
  return repository ? `/api/repos/${encodeRepositoryPathSegments(repository)}/ownership` : null;
}

/** When the CODEOWNERS file was last read, in words a person can check against GitHub. */
export function codeownersSyncLabel(ownership: RepoOwnership): string {
  if (ownership.codeownersSyncedAt === null) return "CODEOWNERS not synced yet";
  const when = new Date(ownership.codeownersSyncedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  if (ownership.codeowners === null) return `No CODEOWNERS file (checked ${when})`;
  return `CODEOWNERS synced ${when}`;
}

function unowned(repo: string): RepoOwnership {
  return {
    repo,
    ownerTeam: null,
    tier: null,
    repoClass: null,
    effectiveRepoClass: "client",
    domain: null,
    dependsOn: null,
    codeowners: null,
    codeownersSyncedAt: null,
  };
}

/**
 * Owner team, tier and class per repository. Everyone who can see the page
 * sees the values and the CODEOWNERS sync time; only holders of
 * `repositories.ownership.manage` can change them.
 */
export function RepoOwnershipSection({
  canManage,
  availableRepos,
}: {
  canManage: boolean;
  availableRepos: EnrichedRepository[];
}) {
  const { data, error } = useSWR<unknown>(REPO_OWNERSHIP_KEY);
  const { data: teamsData } = useSWR<{ teams?: TeamOption[] }>(canManage ? "/api/teams" : null);
  const [adding, setAdding] = useState("");
  const [drafts, setDrafts] = useState<string[]>([]);

  const parsed = repoOwnershipListResponseSchema.safeParse(data);
  const teams = (teamsData?.teams ?? []).filter((team) => team.archivedAt === null);

  const description =
    "Owner team, tier and class for each repository. An unclassified repository is treated as a client repository.";

  if (error || (data !== undefined && !parsed.success)) {
    return (
      <SettingsCardSection title="Repository ownership" description={description}>
        <div role="alert" className="text-sm text-destructive">
          Unable to load repository ownership. Refresh the page to try again.
        </div>
      </SettingsCardSection>
    );
  }

  const repos = parsed.success ? parsed.data.repos : [];
  const onboarded = new Set(repos.map((repo) => repo.repo));
  const rows = [
    ...repos,
    ...drafts.filter((repo) => !onboarded.has(repo)).map((repo) => unowned(repo)),
  ];
  const addable = availableRepos.filter(
    (repo) =>
      !onboarded.has(repo.fullName.toLowerCase()) && !drafts.includes(repo.fullName.toLowerCase())
  );

  return (
    <SettingsCardSection title="Repository ownership" description={description}>
      {rows.length > 0 ? (
        <div className="space-y-2 mb-4">
          {rows.map((ownership) => (
            <OwnershipRow
              key={ownership.repo}
              ownership={ownership}
              teams={teams}
              canManage={canManage}
              onSaved={() => setDrafts((current) => current.filter((r) => r !== ownership.repo))}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">No repository has an owner yet.</p>
      )}

      {canManage && (
        <div className="flex items-center gap-2">
          <Select value={adding} onValueChange={setAdding}>
            <SelectTrigger className="flex-1" aria-label="Select a repository to classify">
              <SelectValue placeholder="Select a repository..." />
            </SelectTrigger>
            <SelectContent>
              {addable.map((repo) => (
                <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                  {repo.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              setDrafts((current) => [...current, adding]);
              setAdding("");
            }}
            disabled={!adding}
          >
            Add repository
          </Button>
        </div>
      )}
    </SettingsCardSection>
  );
}

function OwnershipRow({
  ownership,
  teams,
  canManage,
  onSaved,
}: {
  ownership: RepoOwnership;
  teams: TeamOption[];
  canManage: boolean;
  onSaved: () => void;
}) {
  const [teamId, setTeamId] = useState(ownership.ownerTeam?.id ?? NONE);
  const [tier, setTier] = useState<string>(ownership.tier ?? NONE);
  const [repoClass, setRepoClass] = useState<string>(ownership.repoClass ?? NONE);
  const [domain, setDomain] = useState(ownership.domain ?? "");
  const [dependsOn, setDependsOn] = useState((ownership.dependsOn ?? []).join(", "));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dirty || saving) return;
    setTeamId(ownership.ownerTeam?.id ?? NONE);
    setTier(ownership.tier ?? NONE);
    setRepoClass(ownership.repoClass ?? NONE);
    setDomain(ownership.domain ?? "");
    setDependsOn((ownership.dependsOn ?? []).join(", "));
  }, [ownership, dirty, saving]);

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  const handleSave = async () => {
    const path = ownershipPath(ownership.repo);
    if (!path) return;
    const dependencies = dependsOn
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const body: RepoOwnershipInput = {
      ownerTeamId: teamId === NONE ? null : teamId,
      tier: tier === NONE ? null : (tier as RepoTier),
      repoClass: repoClass === NONE ? null : (repoClass as RepoClass),
      domain: domain.trim() || null,
      dependsOn: dependencies.length > 0 ? dependencies : null,
    };
    setSaving(true);
    try {
      const res = await browserApiFetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await mutate(REPO_OWNERSHIP_KEY);
        setDirty(false);
        onSaved();
        toast.success(`Ownership for ${ownership.repo} saved.`);
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save ownership");
      }
    } catch {
      toast.error("Failed to save ownership");
    } finally {
      setSaving(false);
    }
  };

  const ownerTeamLabel = ownership.ownerTeam?.name ?? "No owner team";
  const teamOptions =
    ownership.ownerTeam && !teams.some((team) => team.id === ownership.ownerTeam?.id)
      ? [...teams, { ...ownership.ownerTeam, archivedAt: null }]
      : teams;

  return (
    <div className="px-4 py-3 border border-border rounded-sm space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-sm font-medium text-foreground truncate">
            {ownership.repo}
          </span>
          <span className="block text-xs text-muted-foreground">
            {ownerTeamLabel} · {ownership.tier ?? "No tier"} ·{" "}
            {CLASS_LABELS[ownership.effectiveRepoClass]}
            {ownership.repoClass === null ? " (unclassified)" : ""} ·{" "}
            {codeownersSyncLabel(ownership)}
          </span>
        </div>
        {canManage && (
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "..." : "Save"}
          </Button>
        )}
      </div>

      {canManage && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">Owner team</span>
            <Select value={teamId} onValueChange={edit(setTeamId)}>
              <SelectTrigger density="compact" aria-label={`Owner team for ${ownership.repo}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No owner team</SelectItem>
                {teamOptions.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">Tier</span>
            <Select value={tier} onValueChange={edit(setTier)}>
              <SelectTrigger density="compact" aria-label={`Tier for ${ownership.repo}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No tier</SelectItem>
                {REPO_TIERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">Class</span>
            <Select value={repoClass} onValueChange={edit(setRepoClass)}>
              <SelectTrigger density="compact" aria-label={`Class for ${ownership.repo}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unclassified (treated as client)</SelectItem>
                {REPO_CLASSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CLASS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="text-sm">
            <span className="block text-muted-foreground mb-1">Domain</span>
            <Input
              value={domain}
              onChange={(event) => edit(setDomain)(event.target.value)}
              placeholder="e.g., factory"
              aria-label={`Domain for ${ownership.repo}`}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="block text-muted-foreground mb-1">Depends on</span>
            <Input
              value={dependsOn}
              onChange={(event) => edit(setDependsOn)(event.target.value)}
              placeholder="owner/name, owner/name"
              aria-label={`Dependencies for ${ownership.repo}`}
            />
          </label>
        </div>
      )}
    </div>
  );
}
