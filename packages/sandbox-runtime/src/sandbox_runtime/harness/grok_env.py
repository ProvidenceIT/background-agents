"""Where the grok harness finds its credential, and what its child may see.

SuperGrok reaches a session only as a short-lived access token the owner's
machine pushes into the subscription home (``pushed_token``,
``$SF_AUTH_HOME/grok/access.json``). The grok child never reads that file
itself: ``GROK_AUTH_PROVIDER_COMMAND`` runs ``grok_auth``, which prints the
token on grok's credential channel. ``GROK_HOME`` is a pod-local, writable
directory (sessions, caches, ``config.toml``); nothing is written into the
shared home, and no refresh token is ever in the pod.

The child's environment drops every other way grok could authenticate (an
xAI key, an auth file, a proxy or provider override), so the pushed token is
the only credential it can use.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Final

from .. import pushed_token
from .base import HarnessStartError
from .claude_env import AUTH_HOME_ENV_VAR, AUTH_HOME_PROVIDERS_ENV_VAR
from .codex_tools import TOOL_SERVER_MODULE

if TYPE_CHECKING:
    from collections.abc import Mapping

    from ..pushed_token import PushedToken

GROK_HOME_ENV_VAR: Final = "GROK_HOME"
AUTH_PROVIDER_COMMAND_ENV_VAR: Final = "GROK_AUTH_PROVIDER_COMMAND"
GROK_CONFIG_FILE: Final = "config.toml"
# The MCP server serving Open Inspect's tools; grok names its tools ``oi__<tool>``.
OI_TOOL_SERVER_NAME: Final = "oi"
AUTH_PROVIDER_MODULE: Final = "sandbox_runtime.harness.grok_auth"

# Credentials grok would prefer over the provider command, or that would
# send a token elsewhere. Every ``GROK_AUTH*`` variable goes too (an auth
# file path, a token TTL, the provider family); the harness sets its own.
GROK_CREDENTIAL_VARS: Final = (
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "GROK_DEPLOYMENT_KEY",
    "GROK_CLI_CHAT_PROXY_BASE_URL",
    "GROK_MODELS_BASE_URL",
    "GROK_MODELS_LIST_URL",
    "XAI_OAUTH_MANAGED",
)
GROK_CREDENTIAL_PREFIX: Final = "GROK_AUTH"
# Fixed for every child: no self-update inside an image, no telemetry.
FIXED_CHILD_ENV: Final = {
    "GROK_DISABLE_AUTOUPDATER": "1",
    "GROK_TELEMETRY_ENABLED": "0",
}

NO_AUTH_HOME: Final = (
    "The SuperGrok harness runs only on a subscription home, and none is mounted in this "
    "sandbox. Enrol one under Settings > Subscription homes, then start a new session."
)
HOME_WITHOUT_GROK: Final = "SuperGrok not enrolled for this home (xai is not among its providers)"


def require_enrolled_home(environ: Mapping[str, str] = os.environ) -> Path:
    """``$SF_AUTH_HOME`` when it is enrolled for SuperGrok; ``HarnessStartError`` otherwise.

    Only an operator can fix either cause, so these are start errors. The
    token itself is checked per turn (``preflight``): a push that stopped
    fails turns until it resumes, and the session survives.
    """
    home = environ.get(AUTH_HOME_ENV_VAR)
    if not home:
        raise HarnessStartError(NO_AUTH_HOME)
    providers = {
        provider.strip()
        for provider in environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
        if provider.strip()
    }
    if pushed_token.PUSHED_CLIS["grok"].provider not in providers:
        raise HarnessStartError(HOME_WITHOUT_GROK)
    return Path(home)


def preflight(environ: Mapping[str, str] = os.environ, now: float | None = None) -> PushedToken:
    """The pushed token a turn can start on; ``HarnessStartError`` naming the cause, never a value.

    No home, a home not enrolled for xai, a missing file, or less than
    ``pushed_token.MIN_REMAINING_SECONDS`` left (the "push stale since" text).
    """
    require_enrolled_home(environ)
    return pushed_token.read("grok", environ, now=now)


def auth_provider_command(python: str = sys.executable) -> str:
    """The ``sh -c`` command grok runs for a token: ``grok_auth`` on this runtime's import path."""
    package_root = str(Path(__file__).resolve().parents[2])
    return f"PYTHONPATH={shlex.quote(package_root)} {shlex.quote(python)} -m {AUTH_PROVIDER_MODULE}"


def build_child_env(
    parent: Mapping[str, str], grok_home: Path, *, python: str = sys.executable
) -> dict[str, str]:
    """The parent's environment minus grok's other credentials, with the pushed-token provider.

    ``HTTPS_PROXY``/``HTTP_PROXY`` and ``SF_AUTH_HOME`` pass through: grok
    reaches xAI through the sandbox proxy, and ``grok_auth`` reads the home.
    """
    stripped = set(GROK_CREDENTIAL_VARS)
    env = {
        name: value
        for name, value in parent.items()
        if name not in stripped and not name.startswith(GROK_CREDENTIAL_PREFIX)
    }
    env[GROK_HOME_ENV_VAR] = str(grok_home)
    env[AUTH_PROVIDER_COMMAND_ENV_VAR] = auth_provider_command(python)
    env.update(FIXED_CHILD_ENV)
    return env


def config_toml(tool_config_path: Path | None, python: str = sys.executable) -> str:
    """``$GROK_HOME/config.toml``: no self-update, no telemetry, and the ``oi`` tool server.

    The ``oi`` server is ``codex_tools`` unchanged, reading its 0600 config.
    TOML basic strings share JSON's escapes, so values are written with
    ``json.dumps``.
    """
    lines = [
        "[cli]",
        "auto_update = false",
        "",
        "[features]",
        "telemetry = false",
    ]
    if tool_config_path is not None:
        package_root = str(Path(__file__).resolve().parents[2])
        args = ["-m", TOOL_SERVER_MODULE, str(tool_config_path)]
        lines += [
            "",
            f"[mcp_servers.{OI_TOOL_SERVER_NAME}]",
            f"command = {json.dumps(python)}",
            f"args = {json.dumps(args)}",
            f"env = {{ PYTHONPATH = {json.dumps(package_root)} }}",
            "startup_timeout_sec = 30",
            # The pull-request tool waits on the sandbox push, up to its own timeout.
            "tool_timeout_sec = 420",
        ]
    return "\n".join(lines) + "\n"


def write_config(grok_home: Path, tool_config_path: Path | None) -> Path:
    """Create ``grok_home`` (0700) and write its ``config.toml``; returns the file's path."""
    grok_home.mkdir(parents=True, exist_ok=True)
    grok_home.chmod(0o700)
    path = grok_home / GROK_CONFIG_FILE
    path.write_text(config_toml(tool_config_path), encoding="utf-8")
    return path
