"""One CLI child per turn, in its own process group (the grok and agy harnesses).

The Codex harness runs its child the same way and keeps its own copy; this
module is the shared shape for the harnesses that came after it:

- ``spawn_group`` starts the child as the leader of a new session, so the
  child and every tool process it starts share one process group.
- ``read_lines_with_inactivity`` yields stdout lines (each up to
  ``STDOUT_LINE_LIMIT_BYTES``) and raises ``InactivityTimeout`` when the
  child stays silent longer than the budget.
- ``read_stderr_tail`` keeps the last stderr lines for a failure message.
- ``reap_group`` waits for a child that finished its turn, and stops it if
  it lingers; ``terminate_group`` stops the whole group (SIGTERM, then
  SIGKILL), including members that outlived the leader.

Nothing here reads a turn's events or knows a vendor's protocol.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path
from typing import TYPE_CHECKING, Final

from .base import HarnessStartError

if TYPE_CHECKING:
    import collections
    from collections.abc import AsyncIterator, Callable, Mapping, Sequence

    from ..log_config import StructuredLogger

# One JSON line can carry a command's whole output.
STDOUT_LINE_LIMIT_BYTES: Final = 16 * 1024 * 1024
STDERR_TAIL_LINES: Final = 20
# Longest stderr line kept in the tail (and logged).
STDERR_LINE_CHARS: Final = 500
# Floor for each signal's wait, however small the caller's budget.
_MIN_SIGNAL_WAIT_SECONDS: Final = 0.1


class InactivityTimeout(Exception):
    """The child printed nothing for longer than ``seconds``."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"no output for {seconds:.0f}s")
        self.seconds = seconds


class LineTooLong(ValueError):
    """The child printed a line longer than ``STDOUT_LINE_LIMIT_BYTES``."""


async def spawn_group(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    cli_label: str,
    stdin_pipe: bool = False,
) -> asyncio.subprocess.Process:
    """Start ``argv`` as the leader of its own process group, stdout and stderr piped.

    stdin is ``/dev/null`` unless ``stdin_pipe``; the caller then writes and
    closes it. A missing binary is a ``HarnessStartError`` naming ``cli_label``.
    """
    try:
        return await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if stdin_pipe else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(env),
            cwd=str(cwd),
            start_new_session=True,
            limit=STDOUT_LINE_LIMIT_BYTES,
        )
    except FileNotFoundError as error:
        raise HarnessStartError(
            f"The {cli_label} CLI is not installed in this sandbox image."
        ) from error


async def read_lines_with_inactivity(
    stream: asyncio.StreamReader, inactivity_timeout_seconds: float
) -> AsyncIterator[bytes]:
    """Each line of ``stream`` until EOF, newline included.

    Raises ``InactivityTimeout`` when no line arrives within the budget (it
    renews on every line), and ``LineTooLong`` for a line over the limit the
    stream was opened with.
    """
    while True:
        try:
            async with asyncio.timeout(inactivity_timeout_seconds):
                line = await stream.readline()
        except TimeoutError as error:
            raise InactivityTimeout(inactivity_timeout_seconds) from error
        except ValueError as error:
            # StreamReader.readline turns a limit overrun into a bare ValueError.
            raise LineTooLong(str(error)) from error
        if not line:
            return
        yield line


async def read_stderr_tail(
    stream: asyncio.StreamReader | None,
    tail: collections.deque[str],
    *,
    on_line: Callable[[str], None] | None = None,
) -> None:
    """Read ``stream`` to EOF, keeping its last non-empty lines in ``tail``.

    ``on_line`` sees every kept line as it arrives (a harness watching for
    a login prompt, a debug log).
    """
    if stream is None:
        return
    while line := await stream.readline():
        text = line.decode("utf-8", errors="replace").rstrip()[:STDERR_LINE_CHARS]
        if text:
            tail.append(text)
            if on_line is not None:
                on_line(text)


def group_alive(pgid: int) -> bool:
    """Whether any live (non-zombie) process is still in process group ``pgid``.

    Zombies do not count: on a pod nothing reaps the orphans that end up
    under PID 1, so a tool process that died after its leader stays in the
    group as a zombie for good, and ``killpg(pgid, 0)`` still finds it.
    """
    try:
        entries = list(Path("/proc").iterdir())
    except OSError:
        return _group_signalable(pgid)
    if not entries:
        return _group_signalable(pgid)
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # State is field 3 and the process group field 5; the name before ")" may hold spaces.
        fields = raw.rpartition(")")[2].split()
        if len(fields) > 2 and fields[2] == str(pgid) and fields[0] not in ("Z", "X", "x"):
            return True
    return False


def _group_signalable(pgid: int) -> bool:
    """``group_alive`` without ``/proc``: any member, zombies included."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Something is there; it is just not ours to signal.
        return True
    return True


async def terminate_group(
    process: asyncio.subprocess.Process,
    timeout_seconds: float,
    *,
    log: StructuredLogger | None = None,
    log_prefix: str = "cli",
) -> bool:
    """Stop the child's whole process group: SIGTERM, then SIGKILL.

    Each signal gets half of ``timeout_seconds``. Members that outlived an
    already-reaped leader (a tool's background process) are stopped too.
    ``True`` once the leader is reaped and the group is empty.
    """
    pgid = process.pid
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if process.returncode is not None and not group_alive(pgid):
            return True
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pgid, sig)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(timeout_seconds / 2, _MIN_SIGNAL_WAIT_SECONDS)
        try:
            async with asyncio.timeout_at(deadline):
                await process.wait()
                # Members outside the leader are not ours to wait for; poll.
                while group_alive(pgid):
                    await asyncio.sleep(0.02)
            return True
        except TimeoutError:
            if log is not None:
                log.warn(f"{log_prefix}.terminate_timeout", signal=sig.name)
    return process.returncode is not None and not group_alive(pgid)


async def reap_group(
    process: asyncio.subprocess.Process,
    timeout_seconds: float,
    *,
    log: StructuredLogger | None = None,
    log_prefix: str = "cli",
) -> int | None:
    """Wait for a child that finished its turn, then make sure its group is empty.

    A leader that does not exit within ``timeout_seconds`` is terminated, as
    is anything still left in its group after it exits. Returns the exit code
    (``None`` if the leader could not be confirmed gone).
    """
    with contextlib.suppress(TimeoutError):
        async with asyncio.timeout(timeout_seconds):
            await process.wait()
    if process.returncode is None or group_alive(process.pid):
        await terminate_group(process, timeout_seconds, log=log, log_prefix=log_prefix)
    return process.returncode
