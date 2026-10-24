"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import type { IntegrationId, IntegrationEntry } from "@open-inspect/shared/types/integrations";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { SettingsCardSection } from "../settings-card-section";
import { Button } from "@/components/ui/button";
import { RadioCard } from "@/components/ui/form-controls";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

interface EnablementSettings {
  enabled?: boolean;
}

type ScopedGlobalConfig<T extends object> = IntegrationEntry<T>["global"];

/** Integrations whose settings are a global default, a repository scope and per-repo overrides. */
type ScopedIntegrationId = Extract<IntegrationId, "code-server" | "vnc" | "session-tools">;

export interface ScopedIntegrationCopy {
  id: ScopedIntegrationId;
  title: string;
  intro: string;
  overrideDescription: string;
  scopeDescription: string;
  allRepositoriesDescription: string;
  selectedRepositoriesDescription: string;
  emptySelectionWarning: string;
  emptyOverrides: string;
  resetDescription: string;
}

interface EnablementIntegrationCopy extends ScopedIntegrationCopy {
  id: Extract<IntegrationId, "code-server" | "vnc">;
  enableLabel: string;
  enableDescription: string;
}

/**
 * The value a scoped integration edits, at both the global and the
 * repository level. `read` turns a stored entry (or nothing stored) into the
 * value the form shows.
 */
export interface ScopedSettingsField<T extends object> {
  read(settings: T | undefined): T;
  /** What a newly added repository override starts with. */
  newOverride: T;
  renderGlobal(value: T, onChange: (value: T) => void): ReactNode;
  renderOverride(value: T, onChange: (value: T) => void, repo: string): ReactNode;
}

interface GlobalResponse<T extends object> {
  settings: ScopedGlobalConfig<T> | null;
}

interface RepoSettingsEntry<T> {
  repo: string;
  settings: T;
}

interface RepoListResponse<T> {
  repos: RepoSettingsEntry<T>[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

function enablementField(copy: EnablementIntegrationCopy): ScopedSettingsField<EnablementSettings> {
  return {
    read: (settings) => ({ enabled: settings?.enabled ?? false }),
    newOverride: { enabled: true },
    renderGlobal: (value, onChange) => (
      <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
        <div>
          <span className="font-medium text-foreground">{copy.enableLabel}</span>
          <p className="text-xs text-muted-foreground mt-0.5">{copy.enableDescription}</p>
        </div>
        <input
          type="checkbox"
          checked={value.enabled ?? false}
          onChange={() => onChange({ enabled: !value.enabled })}
          className="rounded border-border"
        />
      </label>
    ),
    renderOverride: (value, onChange) => (
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={value.enabled ?? false}
          onChange={() => onChange({ enabled: !value.enabled })}
          className="rounded border-border"
        />
        <span className="text-muted-foreground">Enabled</span>
      </label>
    ),
  };
}

/**
 * Renders global and repository enablement settings with each scope editable only by authorized users.
 */
export function EnablementIntegrationSettings({ copy }: { copy: EnablementIntegrationCopy }) {
  return <ScopedIntegrationSettings copy={copy} field={enablementField(copy)} />;
}

/**
 * Renders a global default with a repository scope, and per-repo overrides,
 * each scope editable only by authorized users.
 */
export function ScopedIntegrationSettings<T extends object>({
  copy,
  field,
}: {
  copy: ScopedIntegrationCopy;
  field: ScopedSettingsField<T>;
}) {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageGlobal = hasPermission("integrations.manage");
  const canManageRepos = hasPermission("repositories.settings.manage");
  const globalSettingsKey = `/api/integration-settings/${copy.id}` as const;
  const repoSettingsKey = `/api/integration-settings/${copy.id}/repos` as const;
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse<T>>(globalSettingsKey);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse<T>>(repoSettingsKey);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-1">{copy.title}</h2>
      <p className="text-sm text-muted-foreground mb-6">{copy.intro}</p>

      <fieldset disabled={!canManageGlobal} className="min-w-0">
        <GlobalSettingsSection
          settings={settings}
          availableRepos={availableRepos}
          settingsKey={globalSettingsKey}
          copy={copy}
          field={field}
        />
      </fieldset>

      <SettingsCardSection title="Repository Overrides" description={copy.overrideDescription}>
        <fieldset disabled={!canManageRepos} className="min-w-0">
          <RepoOverridesSection
            overrides={repoOverrides}
            availableRepos={availableRepos}
            settingsKey={repoSettingsKey}
            copy={copy}
            field={field}
          />
        </fieldset>
      </SettingsCardSection>
    </div>
  );
}

function GlobalSettingsSection<T extends object>({
  settings,
  availableRepos,
  settingsKey,
  copy,
  field,
}: {
  settings: ScopedGlobalConfig<T> | null | undefined;
  availableRepos: EnrichedRepository[];
  settingsKey: `/api/integration-settings/${string}`;
  copy: ScopedIntegrationCopy;
  field: ScopedSettingsField<T>;
}) {
  const [value, setValue] = useState<T>(() => field.read(settings?.defaults));
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos == null ? "all" : "selected"
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setValue(field.read(settings.defaults));
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos == null ? "all" : "selected");
      }
      setInitialized(true);
    }
  }, [settings, initialized, field]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleConfirmReset = async () => {
    setSaving(true);

    try {
      const res = await browserApiFetch(settingsKey, { method: "DELETE" });

      if (res.ok) {
        mutate(settingsKey);
        setValue(field.read(undefined));
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const body: ScopedGlobalConfig<T> = { defaults: value };
    if (repoScopeMode === "selected") {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await browserApiFetch(settingsKey, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(settingsKey);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
  };

  return (
    <SettingsCardSection title="Defaults & Scope" description={copy.scopeDescription}>
      <div className="mb-4">
        {field.renderGlobal(value, (next) => {
          setValue(next);
          setDirty(true);
        })}
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name={`${copy.id}-repo-scope`}
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
            }}
            label="All repositories"
            description={copy.allRepositoriesDescription}
          />
          <RadioCard
            name={`${copy.id}-repo-scope`}
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
            }}
            label="Selected repositories"
            description={copy.selectedRepositoriesDescription}
          />
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
                {availableRepos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = enabledRepos.includes(fullName);

                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRepo(repo.fullName)}
                        className="rounded border-border"
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-warning mt-1">{copy.emptySelectionWarning}</p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={() => setShowResetDialog(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>{copy.resetDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCardSection>
  );
}

function RepoOverridesSection<T extends object>({
  overrides,
  availableRepos,
  settingsKey,
  copy,
  field,
}: {
  overrides: RepoSettingsEntry<T>[];
  availableRepos: EnrichedRepository[];
  settingsKey: `/api/integration-settings/${string}/repos`;
  copy: ScopedIntegrationCopy;
  field: ScopedSettingsField<T>;
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const repository = parseRepositoryFullName(addingRepo);
    if (!repository) return;

    try {
      const res = await browserApiFetch(
        `${settingsKey}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: field.newOverride }),
        }
      );

      if (res.ok) {
        mutate(settingsKey);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              settingsKey={settingsKey}
              field={field}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">{copy.emptyOverrides}</p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

function RepoOverrideRow<T extends object>({
  entry,
  settingsKey,
  field,
}: {
  entry: RepoSettingsEntry<T>;
  settingsKey: `/api/integration-settings/${string}/repos`;
  field: ScopedSettingsField<T>;
}) {
  const [value, setValue] = useState<T>(() => field.read(entry.settings));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const handleSave = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!repository) return;
    setSaving(true);
    const settings: T = value;

    try {
      const res = await browserApiFetch(
        `${settingsKey}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        }
      );

      if (res.ok) {
        mutate(settingsKey);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!repository) return;

    try {
      const res = await browserApiFetch(
        `${settingsKey}/${encodeRepositoryPathSegments(repository)}`,
        {
          method: "DELETE",
        }
      );

      if (res.ok) {
        mutate(settingsKey);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div
      role="group"
      aria-label={`${entry.repo} override`}
      className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-sm"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate">{entry.repo}</span>
        {field.renderOverride(
          value,
          (next) => {
            setValue(next);
            setDirty(true);
          },
          entry.repo
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}
