"""Short-lived access tokens the owner's machine pushes into a subscription home.

SuperGrok (grok) and Antigravity (agy) logins never enter a sandbox. Their
refresh tokens stay on the machine they were made on, whose ``sf-cred-push``
timer pushes only the current access token into the home, at
``$SF_AUTH_HOME/<cli>/access.json``:

    {"schema": 1, "provider": ..., "access_token": ..., "expires_at": <epoch s>,
     "pushed_at": <epoch s>, "source": <host>, "account_tag": <8 hex>}

Nothing in a sandbox can refresh it, so a token that is about to expire means
the pushes stopped: ``read`` refuses it with a message that names the last
push, and never the token. ``boot_status`` is what the boot report may say
about the file: ages and the account tag, never a value.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from .harness.base import HarnessStartError
from .harness.claude_env import AUTH_HOME_ENV_VAR, AUTH_HOME_PROVIDERS_ENV_VAR

if TYPE_CHECKING:
    from collections.abc import Mapping

ACCESS_FILE: Final = "access.json"
SCHEMA_VERSION: Final = 1
# A turn needs a token that outlives it; less than this left means the push is stale.
MIN_REMAINING_SECONDS: Final = 600.0
# Named in the stale message when the file does not say where it came from.
_DEFAULT_SOURCE: Final = "the pushing machine"
# The account tag is echoed in the boot report and slot names; anything else is dropped.
_ACCOUNT_TAG = re.compile(r"[A-Za-z0-9_-]{1,32}")
_SOURCE = re.compile(r"[A-Za-z0-9_.-]{1,64}")


@dataclass(frozen=True)
class PushedCli:
    """Where one CLI's pushed token lives, and who it is for."""

    # Directory under the home, and the ``cli`` key callers use.
    directory: str
    # Its id in ``SF_AUTH_HOME_PROVIDERS``.
    provider: str
    # Product name, for messages.
    label: str


PUSHED_CLIS: Final[Mapping[str, PushedCli]] = {
    "grok": PushedCli(directory="grok", provider="xai", label="SuperGrok"),
    "agy": PushedCli(directory="agy", provider="antigravity", label="Antigravity"),
}


@dataclass(frozen=True)
class PushedToken:
    """One validated ``access.json``. ``access_token`` never appears in ``repr``."""

    cli: str
    access_token: str = field(repr=False)
    # Epoch seconds.
    expires_at: float
    pushed_at: float | None
    source: str | None
    account_tag: str | None

    def expires_in_seconds(self, now: float | None = None) -> float:
        return self.expires_at - (time.time() if now is None else now)


def access_path(home: Path, cli: str) -> Path:
    """``<home>/<cli>/access.json``."""
    return home / PUSHED_CLIS[cli].directory / ACCESS_FILE


def read(
    cli: str,
    environ: Mapping[str, str] = os.environ,
    *,
    now: float | None = None,
    min_remaining_seconds: float = MIN_REMAINING_SECONDS,
) -> PushedToken:
    """The mounted home's token for ``cli`` (``grok`` or ``agy``), checked for use.

    Raises ``HarnessStartError`` when no home is mounted, the home is not
    enrolled for the CLI's provider, the file is missing or unreadable, or
    fewer than ``min_remaining_seconds`` are left on the token. No message
    carries a token value.
    """
    spec = PUSHED_CLIS[cli]
    home = environ.get(AUTH_HOME_ENV_VAR)
    if not home:
        raise HarnessStartError(
            f"{spec.label} needs a subscription home, and this session has none mounted."
        )
    providers = {
        provider.strip()
        for provider in environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
        if provider.strip()
    }
    if spec.provider not in providers:
        raise HarnessStartError(f"{spec.label} not enrolled for this home.")
    path = access_path(Path(home), cli)
    token = read_file(path, cli)
    current = time.time() if now is None else now
    if token.expires_in_seconds(current) < min_remaining_seconds:
        raise HarnessStartError(stale_message(token))
    return token


def read_file(path: Path, cli: str) -> PushedToken:
    """Parse ``path`` without an expiry check; ``HarnessStartError`` when unusable."""
    spec = PUSHED_CLIS[cli]
    missing = f"subscription home mounted but {spec.directory}/{ACCESS_FILE} missing"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise HarnessStartError(missing) from error
    except (OSError, UnicodeDecodeError, ValueError) as error:
        # The parser's message can quote the file; say only which file it was.
        raise HarnessStartError(
            f"{spec.directory}/{ACCESS_FILE} in the subscription home is unreadable"
        ) from error
    token = _parse(raw, cli)
    if token is None:
        raise HarnessStartError(
            f"{spec.directory}/{ACCESS_FILE} in the subscription home is not a pushed token"
        )
    return token


def stale_message(token: PushedToken) -> str:
    """Why a nearly expired token is refused, naming the last push and where it comes from."""
    spec = PUSHED_CLIS[token.cli]
    since = _iso(token.pushed_at) if token.pushed_at is not None else "an unknown time"
    return (
        f"{spec.label} credential push stale since {since}; "
        f"check sf-cred-push.timer on {token.source or _DEFAULT_SOURCE}"
    )


def boot_status(home: Path, cli: str, now: float | None = None) -> dict[str, Any]:
    """``{present, expires_in_s, pushed_age_s, account_tag}`` for ``cli``'s file; never a value."""
    current = time.time() if now is None else now
    try:
        token = read_file(access_path(home, cli), cli)
    except HarnessStartError:
        return {"present": False, "expires_in_s": None, "pushed_age_s": None, "account_tag": None}
    return {
        "present": True,
        "expires_in_s": int(token.expires_in_seconds(current)),
        "pushed_age_s": None if token.pushed_at is None else int(current - token.pushed_at),
        "account_tag": token.account_tag,
    }


def _parse(raw: Any, cli: str) -> PushedToken | None:
    if not isinstance(raw, dict):
        return None
    schema = raw.get("schema", SCHEMA_VERSION)
    access_token = raw.get("access_token")
    expires_at = _epoch(raw.get("expires_at"))
    if schema != SCHEMA_VERSION or not isinstance(access_token, str) or not access_token:
        return None
    if expires_at is None:
        return None
    source = raw.get("source")
    account_tag = raw.get("account_tag")
    return PushedToken(
        cli=cli,
        access_token=access_token,
        expires_at=expires_at,
        pushed_at=_epoch(raw.get("pushed_at")),
        source=source if isinstance(source, str) and _SOURCE.fullmatch(source) else None,
        account_tag=(
            account_tag
            if isinstance(account_tag, str) and _ACCOUNT_TAG.fullmatch(account_tag)
            else None
        ),
    )


def _epoch(value: object) -> float | None:
    """Epoch seconds from a number or an ISO 8601 string."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) and value > 0 else None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.timestamp()
    return None


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
