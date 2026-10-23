"""Agent harness seam: one registry, two halves (see ``base.py``)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..claude_stager import ClaudeHarnessHandoff
from ..codex_stager import CodexHarnessHandoff
from ..credentials.provider_credential_client import RuntimeCredentialClient
from ..memories import append_memory, memory_text
from ..opencode_server import resolve_opencode_global_config_dir
from ..session_tools_contract import enabled_gates_from_env
from .base import (
    DEFAULT_HARNESS_ID,
    DETERMINISTIC_FAILURE_EXIT_CODE,
    AgentHarness,
    BridgeEvent,
    EventSink,
    HarnessId,
    HarnessProcessOwner,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    SubscriptionLimit,
    TurnOutcome,
    parse_harness_id,
)
from .claude import ClaudeHarness, ClaudeHarnessConfig
from .claude_env import OAUTH_MANAGED_ENV_VAR
from .claude_tools import ToolServerConfig
from .codex import DEFAULT_CODEX_MODEL, CodexHarness, CodexHarnessConfig
from .opencode import OpencodeHarness
from .opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from pathlib import Path

    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger


@dataclass(frozen=True)
class BridgeIdentity:
    """What a harness needs to call the control plane on the session's behalf."""

    sandbox_id: str
    session_id: str
    control_plane_url: str
    auth_token: str
    repo_manifest_path: Path


def build_agent_harness(
    harness_id: HarnessId,
    *,
    identity: BridgeIdentity,
    attachment_processor: AttachmentProcessor,
    log: StructuredLogger,
    limits: PromptLimits,
    opencode_port: int,
) -> AgentHarness:
    """The bridge-half registry: one ``match`` is the whole thing."""
    match harness_id:
        case HarnessId.OPENCODE:
            return OpencodeHarness(
                client=OpenCodeClient(base_url=f"http://localhost:{opencode_port}", log=log),
                attachment_processor=attachment_processor,
                log=log,
                limits=limits,
                managed_skills_dir=resolve_opencode_global_config_dir() / "skills",
            )
        case HarnessId.CLAUDE:
            handoff = ClaudeHarnessHandoff.read()
            session_config = _session_config_from_env()
            oauth_managed = bool(os.environ.get(OAUTH_MANAGED_ENV_VAR))
            config = ClaudeHarnessConfig(
                workdir=handoff.workdir,
                config_dir=handoff.config_dir,
                # From the bridge's own SESSION_CONFIG: MCP entries can carry
                # credentials, and the handoff file never does.
                mcp_servers=_mcp_servers_from(session_config),
                default_model=str(session_config.get("model") or "claude-sonnet-4-6"),
                oauth_managed=oauth_managed,
                system_prompt_append=append_memory(
                    _repository_guidance(handoff.workdir), handoff.config_dir
                ),
                tools=_tool_server_config(identity, has_repository=handoff.has_repository),
            )
            credential_client = (
                RuntimeCredentialClient(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    sandbox_id=identity.sandbox_id,
                    auth_token=identity.auth_token,
                    log=log,
                )
                if oauth_managed and identity.control_plane_url
                else None
            )
            return ClaudeHarness(
                config=config,
                log=log,
                limits=limits,
                credential_client=credential_client,
            )
        case HarnessId.CODEX:
            codex_handoff = CodexHarnessHandoff.read()
            codex_session_config = _session_config_from_env()
            if _mcp_servers_from(codex_session_config):
                # Repository MCP servers are not wired into Codex yet; say so
                # rather than start a session that silently lacks them.
                log.warn(
                    "codex.mcp_servers_unsupported",
                    count=len(_mcp_servers_from(codex_session_config)),
                )
            return CodexHarness(
                config=CodexHarnessConfig(
                    workdir=codex_handoff.workdir,
                    config_dir=codex_handoff.config_dir,
                    default_model=str(codex_session_config.get("model") or DEFAULT_CODEX_MODEL),
                    # Codex reads the workspace AGENTS.md itself; memory is
                    # what it would otherwise not see.
                    developer_instructions=memory_text(codex_handoff.config_dir),
                    tools=_tool_server_config(
                        identity, has_repository=codex_handoff.has_repository
                    ),
                ),
                log=log,
                limits=limits,
            )
    raise ValueError(f"Unsupported harness: {harness_id}")


def _tool_server_config(identity: BridgeIdentity, *, has_repository: bool) -> ToolServerConfig:
    """Open Inspect's own tools, as the Claude and Codex harnesses serve them."""
    return ToolServerConfig(
        control_plane_url=identity.control_plane_url,
        session_id=identity.session_id,
        auth_token=identity.auth_token,
        repo_manifest_path=identity.repo_manifest_path,
        has_repository=has_repository,
        slack_notify_enabled=os.environ.get("AGENT_SLACK_NOTIFY_ENABLED", "").lower() == "true",
        session_tools=enabled_gates_from_env(),
    )


def _session_config_from_env() -> dict[str, object]:
    import json
    import os

    try:
        parsed = json.loads(os.environ.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _mcp_servers_from(session_config: dict[str, object]) -> tuple[dict[str, object], ...]:
    servers = session_config.get("mcp_servers")
    if not isinstance(servers, list):
        return ()
    return tuple(server for server in servers if isinstance(server, dict))


def _repository_guidance(workdir: Path) -> str | None:
    """Surface the supervisor's workspace AGENTS.md through the system prompt.

    Claude reads CLAUDE.md natively; multi-repo workspaces only carry the
    AGENTS.md the supervisor writes, and nothing is written into repositories.
    """
    notes = workdir / "AGENTS.md"
    if not notes.is_file() or (workdir / "CLAUDE.md").is_file():
        return None
    try:
        text = notes.read_text().strip()
    except OSError:
        return None
    if not text:
        return None
    return "Workspace guidance (AGENTS.md):\n\n" + text


__all__ = [
    "DEFAULT_HARNESS_ID",
    "DETERMINISTIC_FAILURE_EXIT_CODE",
    "AgentHarness",
    "BridgeEvent",
    "BridgeIdentity",
    "EventSink",
    "HarnessId",
    "HarnessProcessOwner",
    "HarnessPrompt",
    "HarnessStartError",
    "PromptLimits",
    "SubscriptionLimit",
    "TurnOutcome",
    "build_agent_harness",
    "parse_harness_id",
]
