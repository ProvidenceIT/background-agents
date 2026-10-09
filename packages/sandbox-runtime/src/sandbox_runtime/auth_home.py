"""What the bridge may say about a mounted subscription auth home.

The control plane mounts the home at ``$SF_AUTH_HOME`` and lists the
providers it carries in ``$SF_AUTH_HOME_PROVIDERS``. The boot report states
whether the mount is there, those providers, and when the Claude token
expires (``claude/expires_at``, written next to the token when it is minted).
It never opens the token or reports any other file.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .harness.claude_env import (
    AUTH_HOME_CLAUDE_EXPIRES_AT,
    AUTH_HOME_ENV_VAR,
    AUTH_HOME_PROVIDERS_ENV_VAR,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

# An expiry is a timestamp; anything longer is not one and is not echoed.
_MAX_EXPIRES_AT_CHARS = 32


def auth_home_boot_report(environ: Mapping[str, str] = os.environ) -> dict[str, Any] | None:
    """``{present, providers, claude_expires_at}``, or ``None`` when no home is expected."""
    home = environ.get(AUTH_HOME_ENV_VAR)
    if not home:
        return None
    root = Path(home)
    providers = [
        provider.strip()
        for provider in environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
        if provider.strip()
    ]
    return {
        "present": root.is_dir(),
        "providers": providers,
        "claude_expires_at": _read_expires_at(root / AUTH_HOME_CLAUDE_EXPIRES_AT),
    }


def _read_expires_at(path: Path) -> int | str | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not raw or len(raw) > _MAX_EXPIRES_AT_CHARS:
        return None
    return int(raw) if raw.isdigit() else raw
