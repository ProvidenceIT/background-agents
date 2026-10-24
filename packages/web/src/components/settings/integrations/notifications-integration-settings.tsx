"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  resolveNotificationSettings,
  type NotificationMode,
  type NotificationSettings,
} from "@open-inspect/shared/types/integrations";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { SettingsCardSection } from "../settings-card-section";
import { Button } from "@/components/ui/button";
import { RadioCard } from "@/components/ui/form-controls";
import { Switch } from "@/components/ui/switch";
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
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

const SETTINGS_KEY = "/api/integration-settings/notifications";

interface GlobalResponse {
  settings: { defaults?: NotificationSettings } | null;
}

const MODE_COPY: Record<NotificationMode, { label: string; description: string }> = {
  off: { label: "Off", description: "No notices are recorded or sent." },
  shadow: {
    label: "Shadow",
    description: "Records each notice it would send, and sends nothing. Use it to try the rules.",
  },
  live: { label: "Live", description: "Owners get a Teams message." },
};

const MODES: NotificationMode[] = ["off", "shadow", "live"];

/**
 * The stored pair as one choice: `enabled` false and `mode` off mean the same
 * thing to an admin, so the form shows only the mode.
 */
export function noticeMode(settings: NotificationSettings | undefined): NotificationMode {
  const resolved = resolveNotificationSettings(settings);
  return resolved.enabled ? resolved.mode : "off";
}

export function noticeSettingsFor(
  mode: NotificationMode,
  rest: Pick<NotificationSettings, "channels" | "skipMotionSessions">
): NotificationSettings {
  return mode === "off" ? { enabled: false, ...rest } : { enabled: true, mode, ...rest };
}

/** Session notices are global: who is told is the session's owner, whatever the repository. */
export function NotificationsIntegrationSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManage = hasPermission("integrations.manage");
  const { data, isLoading } = useSWR<GlobalResponse>(SETTINGS_KEY);

  if (isLoading) return <IntegrationSettingsSkeleton />;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-1">Session notices</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Tell a session&apos;s owner on Teams when the session finishes or needs them. A person gets
        notices once they have signed in with Microsoft and installed the Teams app.
      </p>
      <fieldset disabled={!canManage} className="min-w-0">
        <NoticeSettingsSection stored={data?.settings?.defaults} configured={!!data?.settings} />
      </fieldset>
    </div>
  );
}

function NoticeSettingsSection({
  stored,
  configured,
}: {
  stored: NotificationSettings | undefined;
  configured: boolean;
}) {
  const [mode, setMode] = useState<NotificationMode>(() => noticeMode(stored));
  const [teams, setTeams] = useState(() => resolveNotificationSettings(stored).channels.teams);
  const [skipMotion, setSkipMotion] = useState(
    () => resolveNotificationSettings(stored).skipMotionSessions
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Follow the stored value until the admin edits the form.
  useEffect(() => {
    if (dirty) return;
    const resolved = resolveNotificationSettings(stored);
    setMode(noticeMode(stored));
    setTeams(resolved.channels.teams);
    setSkipMotion(resolved.skipMotionSessions);
  }, [stored, dirty]);

  const save = async () => {
    setSaving(true);
    const defaults = noticeSettingsFor(mode, {
      channels: { teams },
      skipMotionSessions: skipMotion,
    });
    try {
      const res = await browserApiFetch(SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { defaults } }),
      });
      if (res.ok) {
        mutate(SETTINGS_KEY);
        setDirty(false);
        toast.success("Settings saved.");
      } else {
        const body = await res.json();
        toast.error(body.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await browserApiFetch(SETTINGS_KEY, { method: "DELETE" });
      if (res.ok) {
        mutate(SETTINGS_KEY);
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const body = await res.json();
        toast.error(body.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  // Going live is the step that starts messaging people; ask once.
  const handleSave = () =>
    mode === "live" && noticeMode(stored) !== "live" ? setConfirmLive(true) : save();

  return (
    <SettingsCardSection title="Mode and channels" description="Stage the rollout: shadow first.">
      <p className="text-sm font-medium text-foreground mb-2">Mode</p>
      <div className="grid sm:grid-cols-3 gap-2 mb-4">
        {MODES.map((value) => (
          <RadioCard
            key={value}
            name="notifications-mode"
            checked={mode === value}
            onChange={() => {
              setMode(value);
              setDirty(true);
            }}
            label={MODE_COPY[value].label}
            description={MODE_COPY[value].description}
          />
        ))}
      </div>

      <div className="space-y-2 mb-4">
        <label
          htmlFor="notifications-teams"
          className="flex items-center justify-between px-3 py-2 border border-border rounded-sm text-sm"
        >
          <div>
            <span className="font-medium text-foreground">Teams message</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              A direct message from the bot to the session&apos;s owner.
            </p>
          </div>
          <Switch
            id="notifications-teams"
            checked={teams}
            onCheckedChange={(checked) => {
              setTeams(checked);
              setDirty(true);
            }}
          />
        </label>
        <label
          htmlFor="notifications-skip-motion"
          className="flex items-center justify-between px-3 py-2 border border-border rounded-sm text-sm"
        >
          <div>
            <span className="font-medium text-foreground">Leave motion sessions to motion</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              motion tells its own users about the sessions it started.
            </p>
          </div>
          <Switch
            id="notifications-skip-motion"
            checked={skipMotion}
            onCheckedChange={(checked) => {
              setSkipMotion(checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
        {configured && (
          <Button variant="destructive" onClick={() => setConfirmReset(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start sending notices?</AlertDialogTitle>
            <AlertDialogDescription>
              Owners start getting a Teams message when their sessions finish or need them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={save}>Go live</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>
              Reset session notices to the defaults? Notices turn off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={reset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCardSection>
  );
}
