"""grok's external auth provider: the pushed SuperGrok access token, on stdout.

The grok child runs ``python -m sandbox_runtime.harness.grok_auth`` through
``GROK_AUTH_PROVIDER_COMMAND`` (``sh -c``) at start, again about 300s before
the ``expires_in`` it was given runs out, and after a 401. Each run re-reads
``$SF_AUTH_HOME/grok/access.json`` (``pushed_token``), so a token the owner's
machine pushed mid-turn is picked up by the next run. Nothing here can
refresh a token: the refresh token never leaves the owner's machine.

stdout is grok's credential channel and carries exactly one JSON object
``{"access_token", "expires_in"}``. ``expires_in`` is
``EXPIRY_MARGIN_SECONDS`` short of the real expiry, so grok's pre-expiry
re-run lands while the token still works instead of hot-looping on a token
that is about to die. With less than that left, the push is stale: the
command exits 1 with a JSON error on stderr that names the last push, and
never the token.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import TYPE_CHECKING, Final

from .. import pushed_token
from .base import HarnessStartError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from typing import TextIO

# Seconds the reported lifetime is kept short of the token's real expiry.
EXPIRY_MARGIN_SECONDS: Final = 120


def credential(environ: Mapping[str, str], now: float | None = None) -> dict[str, object]:
    """The provider-command payload; ``HarnessStartError`` (never naming a value) when unusable."""
    current = time.time() if now is None else now
    token = pushed_token.read(
        "grok", environ, now=current, min_remaining_seconds=EXPIRY_MARGIN_SECONDS
    )
    expires_in = max(0, int(token.expires_in_seconds(current)) - EXPIRY_MARGIN_SECONDS)
    return {"access_token": token.access_token, "expires_in": expires_in}


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    now: float | None = None,
) -> int:
    del argv  # grok passes none
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    try:
        payload = credential(os.environ if environ is None else environ, now)
    except HarnessStartError as error:
        err.write(json.dumps({"error": str(error)}) + "\n")
        err.flush()
        return 1
    out.write(json.dumps(payload) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
