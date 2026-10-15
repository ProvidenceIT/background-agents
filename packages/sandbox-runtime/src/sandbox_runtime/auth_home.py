"""What the bridge may say about a mounted subscription auth home.

The control plane mounts the home at ``$SF_AUTH_HOME`` and lists the
providers it carries in ``$SF_AUTH_HOME_PROVIDERS``. The boot report states
whether the mount is there, those providers, and when the Claude token
expires (``claude/expires_at``, written next to the token when it is minted).
For a Codex login pool it adds slot counts and names (never a login). It never
opens a token or reports any other file.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .boot_events import REDACTED_VALUE
from .harness import claude_pool, codex_pool
from .harness.claude_env import (
    AUTH_HOME_CLAUDE_EXPIRES_AT,
    AUTH_HOME_CLAUDE_TOKEN,
    AUTH_HOME_ENV_VAR,
    AUTH_HOME_PROVIDERS_ENV_VAR,
)
from .harness.codex_env import AUTH_HOME_CODEX_AUTH, AUTH_HOME_CODEX_DIR
from .harness.codex_pool import LinkState

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
    report: dict[str, Any] = {
        "present": root.is_dir(),
        "providers": providers,
        "claude_expires_at": _read_expires_at(root / AUTH_HOME_CLAUDE_EXPIRES_AT),
    }
    slots = _pool_slot_dirs(root)
    if slots:
        # The pool's first expiry is the one the owner has to act on.
        expiries = [_read_expires_at(slot / _POOL_EXPIRES_AT) for slot in slots]
        known = [(ms, value) for value in expiries if (ms := _expiry_ms(value)) is not None]
        report["claude_pool_slots"] = len(slots)
        report["claude_expires_at"] = min(known)[1] if known else None
    report.update(_codex_pool_report(root))
    return report


def _codex_pool_report(root: Path) -> dict[str, Any]:
    """Slot count, blocked slots by reason, headroom age, and whether a legacy login is in the way.

    Empty without a pool. Stats and the pool's own state files only: no login is opened.
    """
    pool = codex_pool.pool_root(root)
    slots = codex_pool.pool_slots(pool)
    if not slots:
        return {}
    link = codex_pool.link_state(root / AUTH_HOME_CODEX_DIR, pool)
    return {
        "codex_pool_slots": len(slots),
        "codex_pool_blocked": codex_pool.block_reasons(pool),
        "codex_pool_headroom_age_s": codex_pool.headroom_age_seconds(pool),
        "codex_pool_legacy_file": link in (LinkState.LEGACY_FILE, LinkState.FOREIGN_LINK),
    }


# A pool slot's files, under claude/pool/<slot>/ (see harness/claude_pool.py).
_POOL_TOKEN = "oauth-token"
_POOL_EXPIRES_AT = "expires_at"
# The Claude pool, and the Codex login pool beside codex/ (harness/codex_pool.py).
_CLAUDE_POOL = Path("claude") / claude_pool.POOL_DIR
_CODEX_POOL = Path(codex_pool.POOL_DIR)


def _pool_slot_dirs(
    root: Path, pool: Path = _CLAUDE_POOL, credential: str = _POOL_TOKEN
) -> list[Path]:
    """The slots of ``root/pool`` with a non-empty ``credential`` file, by directory.

    Empty without a pool. Sizes only: the report and the redactor's listing
    never open a token here.
    """
    try:
        entries = sorted((root / pool).iterdir())
    except OSError:
        return []
    slots = []
    for entry in entries:
        try:
            if (entry / credential).stat().st_size > 0:
                slots.append(entry)
        except OSError:
            continue
    return slots


def _expiry_ms(value: int | str | None) -> float | None:
    if isinstance(value, int):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return None
    return None


def _read_expires_at(path: Path) -> int | str | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not raw or len(raw) > _MAX_EXPIRES_AT_CHARS:
        return None
    return int(raw) if raw.isdigit() else raw


# The env file next to the Claude token (provider plan keys).
_AUTH_HOME_ENV_FILE = "env"
# Shorter values are not credentials and would redact ordinary words.
_MIN_SECRET_CHARS = 8
# A Claude subscription token has this shape whether or not it is the one in
# the home (a stale copy, one pasted into a prompt).
_CLAUDE_OAUTH_TOKEN = re.compile(r"sk-ant-oat01-[A-Za-z0-9_-]+")


class AuthHomeSecretRedactor:
    """Removes the mounted home's credentials from what the bridge sends out.

    The agent runs as the uid that owns the mounted files and inherits the
    CLI's environment, so a tool call can print a credential (``env``, ``cat
    $SF_AUTH_HOME/...``). Tool output becomes session events the control
    plane stores, so every outbound event is scrubbed of the values the home
    holds now: the Claude token, the ``env`` file's values and every string
    in Codex's ``auth.json`` and in every Codex pool slot's, plus anything
    shaped like a Claude token. The files are re-read only when they change.
    """

    def __init__(self, home: Path) -> None:
        self._home = home
        self._cache: dict[str, tuple[tuple[int, int] | None, tuple[str, ...]]] = {}

    @classmethod
    def from_environ(cls, environ: Mapping[str, str] = os.environ) -> AuthHomeSecretRedactor | None:
        """A redactor for the mounted home, or ``None`` when no home is mounted."""
        home = environ.get(AUTH_HOME_ENV_VAR)
        return cls(Path(home)) if home else None

    def secrets(self) -> tuple[str, ...]:
        """The home's current credential values, longest first."""
        values: set[str] = set()
        values.update(self._read(AUTH_HOME_CLAUDE_TOKEN, _token_values))
        for slot in _pool_slot_dirs(self._home):
            relative = str(slot.relative_to(self._home) / _POOL_TOKEN)
            values.update(self._read(relative, _token_values))
        values.update(self._read(_AUTH_HOME_ENV_FILE, _env_values))
        values.update(self._read(AUTH_HOME_CODEX_AUTH, _json_string_values))
        for slot in _pool_slot_dirs(self._home, _CODEX_POOL, codex_pool.AUTH_FILE):
            relative = str(slot.relative_to(self._home) / codex_pool.AUTH_FILE)
            values.update(self._read(relative, _json_string_values))
        return tuple(sorted(values, key=len, reverse=True))

    def redact(self, event: dict[str, Any]) -> dict[str, Any]:
        """``event`` with every credential value replaced; the input is not changed."""
        secrets = self.secrets()
        return _redact_value(event, secrets)

    def _read(self, relative: str, parse: Any) -> tuple[str, ...]:
        path = self._home / relative
        try:
            stat = path.stat()
            signature: tuple[int, int] | None = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            signature = None
        cached = self._cache.get(relative)
        if cached is not None and cached[0] == signature:
            return cached[1]
        values: tuple[str, ...] = ()
        if signature is not None:
            try:
                values = tuple(
                    value
                    for value in parse(path.read_text(encoding="utf-8"))
                    if len(value) >= _MIN_SECRET_CHARS
                )
            except (OSError, UnicodeDecodeError, ValueError):
                values = ()
        self._cache[relative] = (signature, values)
        return values


def _token_values(text: str) -> list[str]:
    return [text.strip()]


def _env_values(text: str) -> list[str]:
    values = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        _, separator, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if separator and value:
            values.append(value)
    return values


def _json_string_values(text: str) -> list[str]:
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(json.loads(text))
    return found


def _redact_text(text: str, secrets: tuple[str, ...]) -> str:
    for secret in secrets:
        if secret in text:
            text = text.replace(secret, REDACTED_VALUE)
    return _CLAUDE_OAUTH_TOKEN.sub(REDACTED_VALUE, text)


def _redact_value(value: Any, secrets: tuple[str, ...]) -> Any:
    if isinstance(value, str):
        return _redact_text(value, secrets)
    if isinstance(value, dict):
        return {key: _redact_value(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_value(item, secrets) for item in value]
    return value
