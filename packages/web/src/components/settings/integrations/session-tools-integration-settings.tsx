"use client";

import { SESSION_TOOL_GATES, type SessionToolGate } from "@open-inspect/shared/session-tools";
import type { SessionToolsSettings } from "@open-inspect/shared/types/integrations";
import {
  ScopedIntegrationSettings,
  type ScopedSettingsField,
} from "./enablement-integration-settings";

/** One entry per gate, so a new gate cannot ship without a label here. */
const GATE_COPY: Record<SessionToolGate, { label: string; description: string }> = {
  notify: {
    label: "Notify the owner",
    description: "The agent can send the session's owner a Teams message when it needs them.",
  },
  motion_read: {
    label: "Read the motion Task",
    description:
      "The agent can read the Task the session was delegated from. motion sessions only.",
  },
  motion_write: {
    label: "Add a note to the motion Task",
    description: "The agent can add a note to that Task. motion sessions only.",
  },
  repo_context: {
    label: "Read repository ownership",
    description:
      "The agent can read the repository's owner team, tier, class and CODEOWNERS owners.",
  },
};

function toggleGate(tools: SessionToolGate[], gate: SessionToolGate): SessionToolGate[] {
  return tools.includes(gate)
    ? tools.filter((tool) => tool !== gate)
    : SESSION_TOOL_GATES.filter((tool) => tool === gate || tools.includes(tool));
}

const sessionToolsField: ScopedSettingsField<SessionToolsSettings> = {
  read: (settings) => ({ tools: settings?.tools ?? [] }),
  newOverride: { tools: [] },
  renderGlobal: (value, onChange) => (
    <div className="space-y-2">
      {SESSION_TOOL_GATES.map((gate) => (
        <label
          key={gate}
          className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm"
        >
          <div>
            <span className="font-medium text-foreground">{GATE_COPY[gate].label}</span>
            <p className="text-xs text-muted-foreground mt-0.5">{GATE_COPY[gate].description}</p>
          </div>
          <input
            type="checkbox"
            checked={value.tools?.includes(gate) ?? false}
            onChange={() => onChange({ tools: toggleGate(value.tools ?? [], gate) })}
            className="rounded border-border"
          />
        </label>
      ))}
    </div>
  ),
  renderOverride: (value, onChange) => (
    <div className="flex flex-wrap items-center gap-3">
      {SESSION_TOOL_GATES.map((gate) => (
        <label key={gate} className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={value.tools?.includes(gate) ?? false}
            onChange={() => onChange({ tools: toggleGate(value.tools ?? [], gate) })}
            className="rounded border-border"
          />
          <span className="text-muted-foreground">{GATE_COPY[gate].label}</span>
        </label>
      ))}
    </div>
  ),
};

export function SessionToolsIntegrationSettings() {
  return (
    <ScopedIntegrationSettings
      field={sessionToolsField}
      copy={{
        id: "session-tools",
        title: "Session tools",
        intro:
          "Tools the agent may call during a session. A sandbox gets the tools that are on when it starts; turning a tool off also stops calls from sandboxes already running.",
        overrideDescription:
          "Give specific repositories their own tool list. A repository's list replaces the default list.",
        scopeDescription: "Choose the default tools and which repositories get them.",
        allRepositoriesDescription: "Sessions on every accessible repository get the tools above.",
        selectedRepositoriesDescription:
          "Only sessions on repositories in the allowlist get the tools above.",
        emptySelectionWarning: "No repositories selected. No session will get a tool.",
        emptyOverrides: "No repository overrides yet. Add one to give a repository its own tools.",
        resetDescription:
          "Reset the default tools and repository scope? Every session loses its tools unless a repository override gives them. Per-repository overrides are not affected.",
      }}
    />
  );
}
