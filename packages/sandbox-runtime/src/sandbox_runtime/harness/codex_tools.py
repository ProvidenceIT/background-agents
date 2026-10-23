"""Open Inspect's tools for the Codex harness, as a stdio MCP server.

Claude gets these tools from an in-process SDK MCP server; Codex can only
reach MCP servers it launches itself, so the harness registers this module as
the ``oi`` server (``python -m sandbox_runtime.harness.codex_tools <config>``)
and it serves the very same tool definitions, built by ``build_tools``.

The session's control-plane URL and sandbox token reach the server through a
0600 file in the harness's per-sandbox config directory, never through the
Codex command line or ``CODEX_HOME`` (that is the subscription home, shared
by every session the home serves). stdout carries the MCP protocol, so the
server logs to stderr, which Codex keeps out of the conversation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from ..log_config import JSONFormatter, get_logger
from ..session_tools_contract import parse_enabled_gates
from .claude_tools import (
    OI_TOOL_SERVER_NAME,
    ControlPlaneToolClient,
    ToolServerConfig,
    build_tool_server,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

TOOL_CONFIG_FILE_NAME: Final = "oi-tools.json"
TOOL_SERVER_MODULE: Final = "sandbox_runtime.harness.codex_tools"


def write_tool_config(config: ToolServerConfig, directory: Path) -> Path:
    """Write the server's config readable by the sandbox user only; returns its path."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / TOOL_CONFIG_FILE_NAME
    payload = {
        "control_plane_url": config.control_plane_url,
        "session_id": config.session_id,
        "auth_token": config.auth_token,
        "repo_manifest_path": str(config.repo_manifest_path),
        "has_repository": config.has_repository,
        "slack_notify_enabled": config.slack_notify_enabled,
        "session_tools": sorted(config.session_tools),
    }
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    path.chmod(0o600)
    return path


def read_tool_config(path: Path) -> ToolServerConfig:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return ToolServerConfig(
        control_plane_url=str(raw["control_plane_url"]),
        session_id=str(raw["session_id"]),
        auth_token=str(raw["auth_token"]),
        repo_manifest_path=Path(str(raw["repo_manifest_path"])),
        has_repository=bool(raw["has_repository"]),
        slack_notify_enabled=bool(raw["slack_notify_enabled"]),
        # Absent in a file an older runtime wrote: no session tools.
        session_tools=parse_enabled_gates(",".join(raw.get("session_tools", []))),
    )


def tool_server_overrides(config_path: Path, python: str = sys.executable) -> list[str]:
    """``-c`` overrides registering the server with Codex, as ``key=<TOML value>`` strings.

    Codex starts MCP servers with a reduced environment, so the import path
    the runtime itself runs from is passed explicitly.
    """
    package_root = str(Path(__file__).resolve().parents[2])
    prefix = f"mcp_servers.{OI_TOOL_SERVER_NAME}"
    return [
        f"{prefix}.command={json.dumps(python)}",
        f"{prefix}.args={json.dumps(['-m', TOOL_SERVER_MODULE, str(config_path)])}",
        f"{prefix}.env={{PYTHONPATH={json.dumps(package_root)}}}",
        f"{prefix}.startup_timeout_sec=30",
        # The pull-request tool waits on the sandbox push, up to its own timeout.
        f"{prefix}.tool_timeout_sec=420",
    ]


async def serve(config: ToolServerConfig, log: Any) -> None:
    from mcp.server.stdio import stdio_server

    client = ControlPlaneToolClient(config, log)
    server = build_tool_server(client)["instance"]
    try:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        await client.aclose()


def main(argv: Sequence[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        raise SystemExit("usage: python -m sandbox_runtime.harness.codex_tools <config.json>")
    # stdout is the MCP channel: every log line goes to stderr.
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JSONFormatter())
    logging.root.handlers = [handler]
    logging.root.setLevel(logging.INFO)
    log = get_logger("codex_tools", service="sandbox")
    asyncio.run(serve(read_tool_config(Path(args[0])), log))


if __name__ == "__main__":
    main()
