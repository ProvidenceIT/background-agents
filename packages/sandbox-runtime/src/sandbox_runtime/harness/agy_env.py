"""What the Antigravity (agy) child may see, and the two files it reads from ``HOME``.

agy has no config-dir override: it keeps its login, conversations and MCP
config under ``~/.gemini``. The harness runs it on the pod's own writable
``HOME`` (so a tool shell keeps the sandbox's git identity and ``gh``
config) and writes only two files there:

- ``~/.gemini/antigravity-cli/antigravity-oauth-token``: the access token the
  owner's machine pushed into the subscription home (``pushed_token``), with
  no refresh token and no id token, so nothing in the sandbox can refresh the
  Google login. agy reads it as a file login because the child has no D-Bus
  session bus (no keyring).
- ``~/.gemini/config/mcp_config.json``: the ``oi`` stdio server that serves
  Open Inspect's own tools (``codex_tools``), in the shape ``agy mcp add``
  writes.

agy refuses at start a token with less than five minutes left and then waits
for a browser login, so the harness checks the pushed token before every spawn
(``preflight``) and the child never gets that far.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from .. import pushed_token
from .codex_tools import TOOL_SERVER_MODULE

if TYPE_CHECKING:
    from collections.abc import Mapping

    from ..pushed_token import PushedToken

AGY_STATE_DIR: Final = Path(".gemini") / "antigravity-cli"
TOKEN_FILE: Final = AGY_STATE_DIR / "antigravity-oauth-token"
CONVERSATIONS_DIR: Final = AGY_STATE_DIR / "conversations"
AGY_CONFIG_DIR: Final = Path(".gemini") / "config"
MCP_CONFIG_FILE: Final = AGY_CONFIG_DIR / "mcp_config.json"
# Global skills agy discovers in every workspace.
SKILLS_DIR: Final = AGY_CONFIG_DIR / "skills"
OI_TOOL_SERVER_NAME: Final = "oi"

# agy would use any of these ahead of (or instead of) the file login: an API
# key, a service account, a gateway. Prefix families are stripped whole.
STRIPPED_VARS: Final = ("GEMINI_API_KEY",)
STRIPPED_PREFIXES: Final = ("GOOGLE_", "AGY_LLM_GATEWAY_")
# Without a session bus agy skips the keyring and uses the token file; without
# a display (and with a browser that always fails) it cannot open a login page.
UNSET_VARS: Final = ("DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY")
FIXED_VARS: Final[Mapping[str, str]] = {
    "BROWSER": "/bin/false",
    # Undocumented; harmless, and the updater host is not on the egress allowlist anyway.
    "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
}


def preflight(environ: Mapping[str, str], *, now: float | None = None) -> PushedToken:
    """The pushed Antigravity token, or ``HarnessStartError`` naming why there is none.

    Fewer than ten minutes left means the pushes stopped; the message says
    since when, never the token.
    """
    return pushed_token.read("agy", environ, now=now)


def child_env(parent: Mapping[str, str], home: Path) -> dict[str, str]:
    """The parent's environment without Google credentials or a desktop, ``HOME`` on ``home``."""
    env = {
        name: value
        for name, value in parent.items()
        if name not in STRIPPED_VARS
        and name not in UNSET_VARS
        and not name.startswith(STRIPPED_PREFIXES)
    }
    env["HOME"] = str(home)
    env.update(FIXED_VARS)
    return env


def token_payload(token: PushedToken, *, now: float | None = None) -> dict[str, Any]:
    """agy's ``antigravity-oauth-token`` for an access-only login."""
    current = time.time() if now is None else now
    expiry = datetime.fromtimestamp(token.expires_at, UTC).isoformat().replace("+00:00", "Z")
    return {
        "token": {
            "access_token": token.access_token,
            "token_type": "Bearer",
            "expiry": expiry,
            "expires_in": max(0, int(token.expires_at - current)),
        },
        "auth_method": "consumer",
    }


def write_token(home: Path, token: PushedToken, *, now: float | None = None) -> Path:
    """Replace agy's token file atomically, readable by the sandbox user only."""
    path = home / TOKEN_FILE
    _write_private_json(path, token_payload(token, now=now))
    return path


def mcp_config(tool_config_path: Path, python: str = sys.executable) -> dict[str, Any]:
    """``mcp_config.json`` registering the ``oi`` server, as ``agy mcp add`` writes it.

    agy may start MCP servers with a reduced environment, so the import path
    the runtime itself runs from is passed explicitly (as for Codex).
    """
    package_root = str(Path(__file__).resolve().parents[2])
    return {
        "mcpServers": {
            OI_TOOL_SERVER_NAME: {
                "command": python,
                "args": ["-m", TOOL_SERVER_MODULE, str(tool_config_path)],
                "env": {"PYTHONPATH": package_root},
                "disabled": False,
            }
        }
    }


def write_mcp_config(home: Path, tool_config_path: Path | None) -> Path:
    """Write (or, without tools, empty) agy's user-level MCP config."""
    path = home / MCP_CONFIG_FILE
    payload = mcp_config(tool_config_path) if tool_config_path is not None else {"mcpServers": {}}
    _write_private_json(path, payload)
    return path


def conversation_exists(home: Path, conversation_id: str) -> bool:
    """Whether agy still holds the conversation (``conversations/<id>.db``)."""
    try:
        uuid.UUID(conversation_id)
    except ValueError:
        return False
    return (home / CONVERSATIONS_DIR / f"{conversation_id}.db").is_file()


def _write_private_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    temp = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        temp.chmod(0o600)
        temp.replace(path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
