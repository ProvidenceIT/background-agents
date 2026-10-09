"""Where the Codex harness finds its credential, and what its child may see.

Codex reads and refreshes its own ``auth.json``. The harness never opens
that file: it points ``CODEX_HOME`` at the ``codex/`` directory of the
subscription home the control plane mounted at ``$SF_AUTH_HOME`` and checks
only that the file is there. There is no key path (no OpenAI API key exists
anywhere), so the child's environment never carries the OpenAI key family,
and a session without a home, or a home without the file, does not start.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Final

from .base import HarnessStartError
from .claude_env import AUTH_HOME_ENV_VAR, AUTH_HOME_PROVIDERS_ENV_VAR

if TYPE_CHECKING:
    from collections.abc import Mapping

CODEX_HOME_ENV_VAR: Final = "CODEX_HOME"
# The provider id a home lists when it carries a Codex login.
AUTH_HOME_CODEX_PROVIDER: Final = "openai"
AUTH_HOME_CODEX_DIR: Final = "codex"
AUTH_HOME_CODEX_AUTH: Final = f"{AUTH_HOME_CODEX_DIR}/auth.json"

RELOGIN_HINT: Final = (
    "re-login in your auth home (`codex login --device-auth` with CODEX_HOME on the home's "
    "codex/ directory)"
)
# Names the file, never its contents or the home's listing.
AUTH_HOME_CODEX_AUTH_MISSING: Final = (
    f"subscription home mounted but {AUTH_HOME_CODEX_AUTH} missing: {RELOGIN_HINT}"
)
NO_AUTH_HOME: Final = (
    "The Codex harness runs only on a subscription home, and none is mounted in this sandbox. "
    "Enrol one under Settings > Subscription homes, then start a new session."
)
HOME_WITHOUT_CODEX: Final = (
    "The mounted subscription home does not carry a Codex login (openai is not among its "
    f"providers): {RELOGIN_HINT}"
)

# Codex reads an API key from these before it looks at auth.json; the child
# never sees them, so the subscription login is the only credential it can use.
OPENAI_CREDENTIAL_VARS: Final = ("OPENAI_API_KEY", "CODEX_API_KEY")


def codex_home_path(auth_home: str) -> Path:
    """Codex's home inside a mounted subscription home: ``<home>/codex``."""
    return Path(auth_home) / AUTH_HOME_CODEX_DIR


def codex_home(environ: Mapping[str, str] = os.environ) -> Path:
    """``$SF_AUTH_HOME/codex``, or ``HarnessStartError`` when Codex cannot run here.

    Retrying cannot fix any of these causes: the owner must enrol a home or
    log in again, so they are start errors, not transient ones.
    """
    home = environ.get(AUTH_HOME_ENV_VAR)
    if not home:
        raise HarnessStartError(NO_AUTH_HOME)
    providers = {
        provider.strip()
        for provider in environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
        if provider.strip()
    }
    if AUTH_HOME_CODEX_PROVIDER not in providers:
        raise HarnessStartError(HOME_WITHOUT_CODEX)
    path = codex_home_path(home)
    if not (path / "auth.json").is_file():
        raise HarnessStartError(AUTH_HOME_CODEX_AUTH_MISSING)
    return path


def codex_child_env(parent: Mapping[str, str], home: Path) -> dict[str, str]:
    """The parent's environment minus the OpenAI key family, with ``CODEX_HOME`` set."""
    stripped = set(OPENAI_CREDENTIAL_VARS)
    env = {name: value for name, value in parent.items() if name not in stripped}
    env[CODEX_HOME_ENV_VAR] = str(home)
    return env
