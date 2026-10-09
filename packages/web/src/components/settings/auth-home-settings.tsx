"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AUTH_HOME_EXPIRY_NOTICE_MS,
  AUTH_HOME_MAX_CONCURRENT_LIMIT,
  AUTH_HOME_PROVIDER_IDS,
  TRIGGER_KINDS,
  authHomeOwnerUserId,
  type AuthHome,
  type AuthHomeMetadata,
  type AuthHomeProviderId,
  type PutAuthHomeRequest,
  type SubscriptionSharingPolicy,
  type TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
import {
  authHomeRequestFrom,
  deleteOwnAuthHome,
  putOwnAuthHome,
  putSubscriptionSharing,
  useEnrolledAuthHomes,
  useOwnAuthHome,
  useSubscriptionSharing,
} from "@/hooks/use-auth-homes";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useAuthSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const PROVIDER_LABELS: Record<AuthHomeProviderId, string> = {
  anthropic: "Claude",
  openai: "ChatGPT (Codex)",
  xai: "SuperGrok",
  "zai-coding-plan": "Z.AI Coding Plan",
};

const KIND_LABELS: Record<TriggerKind, string> = {
  prompt: "Your own prompts",
  child: "Child sessions",
  mention: "Teams mentions",
  issue_label: "Issue labels",
  pr_event: "Pull request events",
  schedule: "Scheduled automations",
};

/**
 * The provider clauses a shared home runs against, quoted from the terms
 * (notes/account-pool-terms.md), shown before anyone turns sharing on.
 */
export const SHARING_TERMS_CLAUSES = [
  {
    source: "Anthropic Consumer Terms, section 2",
    text: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else or make your Account available to anyone else.",
  },
  {
    source: "OpenAI Sign in with ChatGPT Terms",
    text: "Using one user's subscription to fulfill another user's requests",
  },
  {
    source: "Z.ai GLM Coding Plan subscription terms",
    text: "You shall not share your account or subscription, or allow any other person (including but not limited to your colleagues, friends, customers or any organization) to use your GLM Coding Plan quota",
  },
] as const;

export const SHARING_RISK_ACCEPTANCE = "Proceeding under the risk acceptance recorded 2026-10-09.";

/** OpenAI's wording for background use; recording consent is hygiene, not the permission. */
export const BACKGROUND_CONSENT_QUOTE = "Obtain express consent before background use";

const POLICY_LABELS: Record<SubscriptionSharingPolicy, { title: string; description: string }> = {
  household: {
    title: "Household",
    description:
      "A session runs on its actor's own home first, else on a home an enrolled colleague shares.",
  },
  owner_only: {
    title: "Owner only",
    description: "A session runs on its actor's own home or is refused.",
  },
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function providerList(providers: readonly AuthHomeProviderId[]): string {
  return providers.length === 0
    ? "No providers"
    : providers.map((provider) => PROVIDER_LABELS[provider]).join(", ");
}

/** The Claude token's expiry as the registry reports it, with a warning inside 14 days. */
function ClaudeExpiry({ home, now }: { home: Pick<AuthHome, "claudeExpiresAt">; now: number }) {
  if (home.claudeExpiresAt === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Claude token expiry: not reported yet. A session that mounts the home reports it.
      </p>
    );
  }
  const remaining = home.claudeExpiresAt - now;
  const date = isoDate(home.claudeExpiresAt);
  if (remaining <= 0) {
    return (
      <p
        role="alert"
        className="rounded-md bg-destructive-muted px-3 py-2 text-xs text-destructive"
      >
        Claude token expired on {date}. Mint a new one on your PC and copy it into the home.
      </p>
    );
  }
  if (remaining <= AUTH_HOME_EXPIRY_NOTICE_MS) {
    return (
      <p role="alert" className="rounded-md bg-warning-muted px-3 py-2 text-xs text-warning">
        Claude token expires on {date}, in {Math.max(1, Math.round(remaining / 86_400_000))} days.
        Mint a new one on your PC before then.
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">Claude token expires on {date}.</p>;
}

function SharingTerms() {
  return (
    <div className="space-y-3 text-sm">
      <p>
        Sharing lets enrolled colleagues&apos; sessions run on your subscriptions when they have no
        home of their own for that provider. Each provider&apos;s terms forbid this:
      </p>
      <ul className="space-y-2">
        {SHARING_TERMS_CLAUSES.map((clause) => (
          <li key={clause.source}>
            <blockquote className="border-l-2 border-border pl-3 italic">
              &ldquo;{clause.text}&rdquo;
            </blockquote>
            <span className="text-xs text-muted-foreground">{clause.source}</span>
          </li>
        ))}
      </ul>
      <p className="font-medium">{SHARING_RISK_ACCEPTANCE}</p>
      <p className="text-xs text-muted-foreground">
        Every turn served for someone else is audited and listed in the home owner&apos;s weekly
        digest.
      </p>
    </div>
  );
}

function SharingConfirmation({
  open,
  title,
  confirmLabel,
  saving,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <SharingTerms />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface HomeDraft {
  kindsEnabled: TriggerKind[];
  backgroundConsent: boolean;
  maxConcurrent: number;
}

function draftFrom(home: AuthHome): HomeDraft {
  return {
    kindsEnabled: [...home.kindsEnabled],
    backgroundConsent: home.backgroundConsentAt !== null,
    maxConcurrent: home.maxConcurrent,
  };
}

function sameDraft(a: HomeDraft, b: HomeDraft): boolean {
  return (
    a.backgroundConsent === b.backgroundConsent &&
    a.maxConcurrent === b.maxConcurrent &&
    a.kindsEnabled.length === b.kindsEnabled.length &&
    a.kindsEnabled.every((kind) => b.kindsEnabled.includes(kind))
  );
}

function OwnHome({
  home,
  viewerUserId,
  onSaved,
  onRemoved,
}: {
  home: AuthHome;
  viewerUserId: string | null;
  onSaved: (home: AuthHome) => void;
  onRemoved: () => void;
}) {
  const saved = draftFrom(home);
  const [draft, setDraft] = useState<HomeDraft>(saved);
  const [saving, setSaving] = useState(false);
  const [confirmShare, setConfirmShare] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isOwner = viewerUserId !== null && authHomeOwnerUserId(home) === viewerUserId;
  const dirty = !sameDraft(draft, saved);

  async function save(change: Partial<PutAuthHomeRequest>, success: string) {
    setSaving(true);
    try {
      onSaved(await putOwnAuthHome({ ...authHomeRequestFrom(home), ...change }));
      toast.success(success);
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Failed to save the home");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function toggleKind(kind: TriggerKind, enabled: boolean) {
    setDraft((current) => ({
      ...current,
      kindsEnabled: enabled
        ? TRIGGER_KINDS.filter((item) => item === kind || current.kindsEnabled.includes(item))
        : current.kindsEnabled.filter((item) => item !== kind),
    }));
  }

  return (
    <section aria-labelledby="own-home-heading" className="rounded-md border border-border-muted">
      <div className="space-y-2 border-b border-border-muted p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="own-home-heading" className="font-medium text-foreground">
            Your home
          </h3>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              home.status === "active"
                ? "bg-success-muted text-success"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {home.status === "active" ? "Active" : "Disabled"}
          </span>
        </div>
        <dl className="grid gap-x-5 gap-y-1 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Providers</dt>
            <dd className="text-foreground">{providerList(home.providers)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Volume</dt>
            <dd className="break-all font-mono text-foreground">
              {home.pvcName} on {home.nodeName}
            </dd>
          </div>
        </dl>
        {home.providers.includes("anthropic") && <ClaudeExpiry home={home} now={Date.now()} />}
      </div>

      <div className="space-y-5 p-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">
            Sessions that may run here
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TRIGGER_KINDS.map((kind) => (
              <div key={kind} className="flex items-center gap-2">
                <Checkbox
                  id={`auth-home-kind-${kind}`}
                  checked={draft.kindsEnabled.includes(kind)}
                  disabled={saving}
                  onCheckedChange={(checked) => toggleKind(kind, checked === true)}
                />
                <Label htmlFor={`auth-home-kind-${kind}`} className="text-sm font-normal">
                  {KIND_LABELS[kind]}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>

        <div className="flex items-start gap-2">
          <Checkbox
            id="auth-home-background-consent"
            className="mt-0.5"
            checked={draft.backgroundConsent}
            disabled={saving}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, backgroundConsent: checked === true }))
            }
          />
          <Label htmlFor="auth-home-background-consent" className="text-sm font-normal">
            I consent to background use of my home: every session kind other than my own prompts.
            <span className="mt-1 block text-xs text-muted-foreground">
              OpenAI&apos;s terms say &ldquo;{BACKGROUND_CONSENT_QUOTE}&rdquo;. This records yours;
              it is hygiene, not the permission.
            </span>
          </Label>
        </div>

        <div className="max-w-48">
          <Label htmlFor="auth-home-max-concurrent">Sessions at once</Label>
          <Input
            id="auth-home-max-concurrent"
            type="number"
            min={1}
            max={AUTH_HOME_MAX_CONCURRENT_LIMIT}
            value={draft.maxConcurrent}
            disabled={saving}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isInteger(value) &&
                value >= 1 &&
                value <= AUTH_HOME_MAX_CONCURRENT_LIMIT
              ) {
                setDraft((current) => ({ ...current, maxConcurrent: value }));
              }
            }}
          />
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={saving || !dirty}
            onClick={() => void save(draft, "Subscription home saved")}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="subtle"
            disabled={saving || !dirty}
            onClick={() => setDraft(saved)}
          >
            Discard
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t border-border-muted p-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="auth-home-shared" className="text-sm font-medium">
            Share with enrolled colleagues
          </Label>
          <Switch
            id="auth-home-shared"
            checked={home.shared}
            disabled={saving || !isOwner}
            onCheckedChange={(checked) => {
              if (checked) setConfirmShare(true);
              else void save({ shared: false }, "Sharing turned off");
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {isOwner
            ? "Under the household policy, a colleague with no home for a provider may run on yours. Turning this off stops it from the next turn."
            : "Only the home's owner can change whether it is shared."}
        </p>
      </div>

      <div className="border-t border-border-muted p-4">
        <Button
          size="sm"
          variant="subtle"
          className="text-destructive"
          disabled={saving}
          onClick={() => setConfirmRemove(true)}
        >
          Remove registration
        </Button>
      </div>

      <SharingConfirmation
        open={confirmShare}
        title="Share your home with enrolled colleagues?"
        confirmLabel="Share my home"
        saving={saving}
        onCancel={() => setConfirmShare(false)}
        onConfirm={() =>
          void save({ shared: true }, "Home shared").then((ok) => ok && setConfirmShare(false))
        }
      />

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your home registration?</AlertDialogTitle>
            <AlertDialogDescription>
              New sessions stop running on it. The volume and the credentials in it stay on the
              node; remove those there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                setSaving(true);
                deleteOwnAuthHome()
                  .then(() => {
                    setConfirmRemove(false);
                    toast.success("Registration removed");
                    onRemoved();
                  })
                  .catch((caught: unknown) =>
                    toast.error(caught instanceof Error ? caught.message : "Failed to remove")
                  )
                  .finally(() => setSaving(false));
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RegisterHome({ onSaved }: { onSaved: (home: AuthHome) => void }) {
  const [pvcName, setPvcName] = useState("sf-home-");
  const [nodeName, setNodeName] = useState("");
  const [providers, setProviders] = useState<AuthHomeProviderId[]>([]);
  const [saving, setSaving] = useState(false);

  async function register() {
    setSaving(true);
    try {
      onSaved(
        await putOwnAuthHome({
          pvcName: pvcName.trim(),
          nodeName: nodeName.trim(),
          providers,
          kindsEnabled: [...TRIGGER_KINDS],
          backgroundConsent: false,
          maxConcurrent: 3,
          shared: false,
          status: "active",
        })
      );
      toast.success("Subscription home registered");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Failed to register the home");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="register-home-heading"
      className="space-y-4 rounded-md border border-border-muted p-4"
    >
      <div>
        <h3 id="register-home-heading" className="font-medium text-foreground">
          No home is registered for you
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Enrol the home on its node first (the volume claim and the credential files), then
          register the claim here. Until then your sessions run on a colleague&apos;s shared home or
          are refused.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="auth-home-pvc">Volume claim</Label>
          <Input
            id="auth-home-pvc"
            value={pvcName}
            disabled={saving}
            onChange={(event) => setPvcName(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="auth-home-node">Node</Label>
          <Input
            id="auth-home-node"
            value={nodeName}
            disabled={saving}
            onChange={(event) => setNodeName(event.target.value)}
          />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Providers in the home</legend>
        {AUTH_HOME_PROVIDER_IDS.map((provider) => (
          <div key={provider} className="flex items-center gap-2">
            <Checkbox
              id={`auth-home-provider-${provider}`}
              checked={providers.includes(provider)}
              disabled={saving}
              onCheckedChange={(checked) =>
                setProviders((current) =>
                  checked === true
                    ? AUTH_HOME_PROVIDER_IDS.filter(
                        (item) => item === provider || current.includes(item)
                      )
                    : current.filter((item) => item !== provider)
                )
              }
            />
            <Label htmlFor={`auth-home-provider-${provider}`} className="text-sm font-normal">
              {PROVIDER_LABELS[provider]}
            </Label>
          </div>
        ))}
      </fieldset>
      <Button
        size="sm"
        disabled={saving || !nodeName.trim() || providers.length === 0}
        onClick={() => void register()}
      >
        Register
      </Button>
    </section>
  );
}

function WorkspacePolicy({ canManage }: { canManage: boolean }) {
  const { sharing, loading, error, mutate } = useSubscriptionSharing();
  const [confirmHousehold, setConfirmHousehold] = useState(false);
  const [saving, setSaving] = useState(false);

  async function apply(policy: SubscriptionSharingPolicy) {
    setSaving(true);
    try {
      await mutate(await putSubscriptionSharing(policy), { revalidate: false });
      toast.success(`Subscription sharing set to ${POLICY_LABELS[policy].title.toLowerCase()}`);
      setConfirmHousehold(false);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Failed to change the policy");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;
  if (error || !sharing) {
    return <ErrorBanner role="alert">Failed to load the workspace sharing policy.</ErrorBanner>;
  }
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Workspace policy: {POLICY_LABELS[sharing.policy].title}.{" "}
        {POLICY_LABELS[sharing.policy].description}
      </p>
    );
  }
  return (
    <section
      aria-labelledby="workspace-sharing-heading"
      className="space-y-3 rounded-md border border-border-muted p-4"
    >
      <h3 id="workspace-sharing-heading" className="font-medium text-foreground">
        Workspace sharing policy
      </h3>
      <div role="radiogroup" aria-labelledby="workspace-sharing-heading" className="space-y-2">
        {(["household", "owner_only"] as const).map((policy) => (
          <label key={policy} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="subscription-sharing-policy"
              value={policy}
              className="mt-1"
              checked={sharing.policy === policy}
              disabled={saving}
              onChange={() => {
                if (policy === "household") setConfirmHousehold(true);
                else void apply(policy);
              }}
            />
            <span>
              <span className="font-medium text-foreground">{POLICY_LABELS[policy].title}</span>
              <span className="block text-xs text-muted-foreground">
                {POLICY_LABELS[policy].description}
              </span>
            </span>
          </label>
        ))}
      </div>
      <SharingConfirmation
        open={confirmHousehold}
        title="Let enrolled people use each other's shared homes?"
        confirmLabel="Switch to household"
        saving={saving}
        onCancel={() => setConfirmHousehold(false)}
        onConfirm={() => void apply("household")}
      />
    </section>
  );
}

function EnrolledHomes({ homes }: { homes: AuthHomeMetadata[] }) {
  const now = Date.now();
  return (
    <section
      aria-labelledby="enrolled-homes-heading"
      className="overflow-hidden rounded-md border border-border-muted"
    >
      <h3 id="enrolled-homes-heading" className="border-b border-border-muted p-4 font-medium">
        Enrolled homes
      </h3>
      {homes.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No homes are enrolled.</p>
      ) : (
        <ul className="divide-y divide-border-muted">
          {homes.map((home) => (
            <li key={home.id} className="space-y-1 p-4 text-xs">
              <div className="font-mono text-foreground">{authHomeOwnerUserId(home)}</div>
              <div className="text-muted-foreground">
                {providerList(home.providers)} / {home.shared ? "Shared" : "Not shared"} /{" "}
                {home.status === "active" ? "Active" : "Disabled"} / {home.maxConcurrent} at once
              </div>
              {home.providers.includes("anthropic") && <ClaudeExpiry home={home} now={now} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Settings > Subscription homes: the caller's own home (providers, token
 * expiry, the kinds and background use it consents to, concurrency, and the
 * owner-only switch that shares it), the workspace sharing policy for those
 * who manage it, and every enrolled home for those who may read them.
 */
export function AuthHomeSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const { data: session } = useAuthSession();
  const viewerUserId = session?.user?.id ?? null;
  const { home, loading, error, mutate } = useOwnAuthHome();
  const canReadAll = hasPermission("auth_homes.read_all");
  const enrolled = useEnrolledAuthHomes(canReadAll);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Subscription homes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your sessions run on the subscriptions in your own home. The control plane never holds the
          credentials: the provider&apos;s own tool reads them from the mounted home.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading your subscription home...</p>
      ) : error ? (
        <ErrorBanner role="alert">Failed to load your subscription home.</ErrorBanner>
      ) : home ? (
        <OwnHome
          // A saved home resets the draft to what the control plane stored.
          key={`${home.id}:${home.updatedAt}`}
          home={home}
          viewerUserId={viewerUserId}
          onSaved={(next) => void mutate(next, { revalidate: false })}
          onRemoved={() => void mutate(null, { revalidate: false })}
        />
      ) : (
        <RegisterHome onSaved={(next) => void mutate(next, { revalidate: false })} />
      )}

      <WorkspacePolicy canManage={hasPermission("subscription_sharing.manage")} />

      {canReadAll &&
        (enrolled.error ? (
          <ErrorBanner role="alert">Failed to load the enrolled homes.</ErrorBanner>
        ) : (
          !enrolled.loading && <EnrolledHomes homes={enrolled.homes} />
        ))}
    </div>
  );
}
