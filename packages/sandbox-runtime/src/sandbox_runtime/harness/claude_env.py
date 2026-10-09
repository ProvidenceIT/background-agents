"""Clean-credential launch for the Claude Agent SDK child.

The SDK merges ``os.environ`` under ``ClaudeAgentOptions.env`` when it spawns
the ``claude`` binary, and the bridge inherits the supervisor's full
environment, including the platform-delivered ``ANTHROPIC_API_KEY``. So the
harness never hands the SDK the real binary. It hands it a generated wrapper
that re-executes the binary with the sandbox environment minus the Anthropic
credentials that do not belong to the active auth mode, for every invocation
including the SDK's version probe.

Everything else passes through, exactly as it does for OpenCode: the sandbox
token, ``SESSION_CONFIG`` and user secrets are what ``oi-git-sign``,
``oi-git-credentials``, ``upload-media`` and the agent's own commands need.
The wrapper carries variable *names* only. Credential values travel through
``ClaudeAgentOptions.env`` in process memory and are never written to disk.

A subscription auth home is the exception to "values in memory": the token is
already on disk, in the home the control plane mounted at ``$SF_AUTH_HOME``
(the subscriber's own ``claude setup-token`` output). In that mode the bridge
never reads it; the wrapper reads ``claude/oauth-token`` at each exec into
``CLAUDE_CODE_OAUTH_TOKEN``, so a token the owner rotates is picked up by the
next child, and the wrapper names only the file's path.
"""

from __future__ import annotations

import json
import math
import os
import stat
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping

# Credential variables per auth mode. Exactly one mode is ever active: the
# child sees either the key family or the OAuth token, never both, so the
# family of the *other* mode is what the wrapper strips.
API_KEY_CREDENTIAL_VARS: Final[tuple[str, ...]] = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
)
OAUTH_CREDENTIAL_VARS: Final[tuple[str, ...]] = ("CLAUDE_CODE_OAUTH_TOKEN",)

OAUTH_TOKEN_ENV_VAR: Final = "CLAUDE_CODE_OAUTH_TOKEN"
API_KEY_ENV_VAR: Final = "ANTHROPIC_API_KEY"
OAUTH_MANAGED_ENV_VAR: Final = "ANTHROPIC_OAUTH_MANAGED"
CONFIG_DIR_ENV_VAR: Final = "CLAUDE_CONFIG_DIR"

# The subscription auth home, as the Kubernetes provider mounts it.
AUTH_HOME_ENV_VAR: Final = "SF_AUTH_HOME"
AUTH_HOME_PROVIDERS_ENV_VAR: Final = "SF_AUTH_HOME_PROVIDERS"
AUTH_HOME_CLAUDE_TOKEN: Final = "claude/oauth-token"
AUTH_HOME_CLAUDE_EXPIRES_AT: Final = "claude/expires_at"
# Claude Code's bare mode skips OAuth and reads only an API key; an auth-home
# child must never run in it.
BARE_FLAG: Final = "--bare"
# Names the file, never its contents or the home's listing.
AUTH_HOME_TOKEN_MISSING: Final = f"subscription home mounted but {AUTH_HOME_CLAUDE_TOKEN} missing"

WRAPPER_NAME: Final = "claude-clean-env"

CLAUDE_POLICY_SETTINGS: Final = json.dumps(
    {
        "attribution": {"commit": "", "pr": "", "sessionUrl": False},
        "feedbackDrafts": "off",
        "feedbackSurveyRate": 0,
    },
    separators=(",", ":"),
)

# How long the child may run one Bash call, and therefore how long the SDK
# stream may legitimately say nothing: it carries no message between a tool
# call and its result, and no keepalive. Both variables reach the child
# untouched (the wrapper strips credentials only), so the bridge resolves the
# ceiling from the same environment the child reads rather than keeping a
# second copy of the number that can disagree with it.
BASH_MAX_TIMEOUT_ENV_VAR: Final = "BASH_MAX_TIMEOUT_MS"
BASH_DEFAULT_TIMEOUT_ENV_VAR: Final = "BASH_DEFAULT_TIMEOUT_MS"
# The CLI's built-ins, which apply while the environment overrides neither.
CLI_BASH_MAX_TIMEOUT_SECONDS: Final = 600.0
CLI_BASH_DEFAULT_TIMEOUT_SECONDS: Final = 120.0
# Slack over the ceiling, for delivering a large tool result and re-entering
# the model once the tool returns.
STREAM_SILENCE_MARGIN_SECONDS: Final = 300.0


def bash_timeout_ceiling_seconds(environ: Mapping[str, str] = os.environ) -> float:
    """The longest single Bash call the child will allow, by the CLI's own rule.

    The CLI takes the larger of its max and default timeouts, each overridable
    from the environment; a value that does not parse, or is not positive, is
    ignored in favour of the built-in.
    """
    return max(
        _milliseconds_as_seconds(environ.get(BASH_MAX_TIMEOUT_ENV_VAR))
        or CLI_BASH_MAX_TIMEOUT_SECONDS,
        _milliseconds_as_seconds(environ.get(BASH_DEFAULT_TIMEOUT_ENV_VAR))
        or CLI_BASH_DEFAULT_TIMEOUT_SECONDS,
    )


def stream_silence_budget_seconds(environ: Mapping[str, str] = os.environ) -> float:
    """How long the SDK stream may say nothing before the turn counts as stuck.

    Every other Claude tool stays well inside the Bash ceiling: MCP calls
    carry their own wall-clock limit, and a sub-agent's own tool calls keep
    arriving on this stream while it works.
    """
    return bash_timeout_ceiling_seconds(environ) + STREAM_SILENCE_MARGIN_SECONDS


def _milliseconds_as_seconds(raw: str | None) -> float | None:
    """An environment duration in milliseconds, or ``None`` when unusable."""
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return value / 1000.0


class ClaudeAuthMode(StrEnum):
    API_KEY = "api_key"
    OAUTH_TOKEN = "oauth_token"
    # The subscriber's token, read from the mounted home by the wrapper.
    AUTH_HOME = "auth_home"


@dataclass(frozen=True)
class ClaudeCredential:
    """The one credential the child receives, held in memory only."""

    mode: ClaudeAuthMode
    # Variables to pass through ``ClaudeAgentOptions.env``; never logged.
    env: Mapping[str, str]
    # AUTH_HOME only: the file the wrapper reads the token from at exec time.
    token_file: Path | None = None

    @classmethod
    def api_key(cls, environ: Mapping[str, str]) -> ClaudeCredential | None:
        """Adopt the bridge's Anthropic key family (a user-configured gateway keeps working)."""
        if not environ.get(API_KEY_ENV_VAR):
            return None
        return cls(
            ClaudeAuthMode.API_KEY,
            {name: environ[name] for name in API_KEY_CREDENTIAL_VARS if environ.get(name)},
        )

    @classmethod
    def oauth_token(cls, token: str) -> ClaudeCredential:
        return cls(ClaudeAuthMode.OAUTH_TOKEN, {OAUTH_TOKEN_ENV_VAR: token})

    @classmethod
    def auth_home(cls, token_file: Path) -> ClaudeCredential:
        """The home's token, by path: no value passes through the bridge."""
        return cls(ClaudeAuthMode.AUTH_HOME, {}, token_file)


def auth_home_claude_token_file(environ: Mapping[str, str] = os.environ) -> Path | None:
    """Where the mounted home keeps the Claude token, when it carries Anthropic.

    ``None`` when no home is mounted or the home is not for Anthropic; the
    file itself may still be missing, which the caller refuses.
    """
    home = environ.get(AUTH_HOME_ENV_VAR)
    if not home:
        return None
    providers = {
        provider.strip() for provider in environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
    }
    if "anthropic" not in providers:
        return None
    return Path(home) / AUTH_HOME_CLAUDE_TOKEN


def denylist_for(mode: ClaudeAuthMode) -> tuple[str, ...]:
    """The credential family the child must never see in ``mode``.

    An auth-home child gets its OAuth token from the home's file only, so
    the API-key family is stripped and any inherited token is replaced.
    """
    return OAUTH_CREDENTIAL_VARS if mode is ClaudeAuthMode.API_KEY else API_KEY_CREDENTIAL_VARS


def clean_child_env(
    parent: Mapping[str, str], mode: ClaudeAuthMode, extra: Mapping[str, str]
) -> dict[str, str]:
    """What the child ends up with: parent+extra minus the other mode's credentials.

    This is the reference the sentinel test compares the wrapper's real
    output against.
    """
    merged = {**parent, **extra}
    stripped = set(denylist_for(mode))
    return {name: value for name, value in merged.items() if name not in stripped}


def bundled_claude_binary() -> Path:
    """The ``claude`` binary the pinned SDK wheel ships (``claude_agent_sdk/_bundled``)."""
    import claude_agent_sdk

    package_dir = Path(claude_agent_sdk.__file__).parent
    binary = package_dir / "_bundled" / "claude"
    if not binary.is_file():
        raise FileNotFoundError(f"The Claude Agent SDK wheel has no bundled binary at {binary}")
    return binary


def write_clean_env_wrapper(
    directory: Path,
    *,
    mode: ClaudeAuthMode,
    binary: Path,
    python_executable: str | None = None,
    token_file: Path | None = None,
) -> Path:
    """Generate the wrapper set as ``ClaudeAgentOptions.cli_path``.

    A Python script rather than a shell one so the denylist is applied
    exactly (no word splitting, no accidental empty exports). It re-executes
    ``binary`` with its own environment, which is the SDK's merged
    ``os.environ`` + ``options.env``, minus the other mode's credentials.

    In ``AUTH_HOME`` mode it also reads ``token_file`` at each exec into
    ``CLAUDE_CODE_OAUTH_TOKEN`` and drops ``--bare``; a missing or empty file
    stops the child with a message that names neither the token nor the
    home's contents.
    """
    python = python_executable or sys.executable
    names = denylist_for(mode)
    if mode is ClaudeAuthMode.AUTH_HOME:
        if token_file is None:
            raise ValueError("auth_home mode needs the home's token file")
        handoff = [
            f"TOKEN_FILE = {str(token_file)!r}",
            "try:",
            "    with open(TOKEN_FILE, encoding='utf-8') as handle:",
            "        token = handle.read().strip()",
            "except OSError:",
            "    token = ''",
            "if not token:",
            f"    sys.stderr.write({AUTH_HOME_TOKEN_MISSING + chr(10)!r})",
            "    sys.exit(78)",
            f"env[{OAUTH_TOKEN_ENV_VAR!r}] = token",
            f"args = [arg for arg in sys.argv[1:] if arg != {BARE_FLAG!r}]",
        ]
    else:
        handoff = ["args = sys.argv[1:]"]
    script = "\n".join(
        [
            f"#!{python}",
            '"""Generated by the Open Inspect Claude harness. Do not edit."""',
            "import os",
            "import sys",
            "",
            f"BINARY = {str(binary)!r}",
            f"DENYLIST = frozenset({names!r})",
            "",
            "env = {name: value for name, value in os.environ.items() if name not in DENYLIST}",
            *handoff,
            "os.execve(BINARY, [BINARY, *args], env)",
            "",
        ]
    )
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = directory / WRAPPER_NAME
    wrapper.write_text(script)
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def harness_env(config_dir: Path, credential: ClaudeCredential) -> dict[str, str]:
    """``ClaudeAgentOptions.env``: config dir, policy, and the one credential."""
    return {
        CONFIG_DIR_ENV_VAR: str(config_dir),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        # A background sub-agent returns a result before its work is done and
        # delivers the findings on a later injected turn. Foreground sub-agents
        # launched in one message still run concurrently, as OpenCode's task
        # tool does.
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1",
        # Open-Inspect's memory tools are the agent's only memory. The CLI's
        # file-based auto memory would compete with them in the system prompt;
        # this variable overrides any settings file that enables it.
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_TELEMETRY": "1",
        # Anthropic telemetry and opt-in customer OpenTelemetry are separate.
        "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
        "OTEL_TRACES_EXPORTER": "none",
        **credential.env,
    }


def resolve_api_key_credential(environ: Mapping[str, str] = os.environ) -> ClaudeCredential | None:
    return ClaudeCredential.api_key(environ)
