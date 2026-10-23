"""The child-per-turn process helper: groups, silence budgets, line limits, stderr tails."""

from __future__ import annotations

import asyncio
import collections
import json
import os
import sys
from pathlib import Path

import pytest

from sandbox_runtime.harness import HarnessStartError
from sandbox_runtime.harness.cli_process import (
    STDOUT_LINE_LIMIT_BYTES,
    InactivityTimeout,
    LineTooLong,
    group_alive,
    read_lines_with_inactivity,
    read_stderr_tail,
    reap_group,
    spawn_group,
    terminate_group,
)

# Starts a grandchild sleep in the same group, prints its pid, then sleeps itself.
_PARENT_WITH_GRANDCHILD = """
import subprocess, sys, time
child = subprocess.Popen(["sleep", "60"])
print(child.pid, flush=True)
time.sleep(60)
"""
# Starts a grandchild that outlives it, then exits.
_LEADER_LEAVES_A_GRANDCHILD = """
import subprocess
child = subprocess.Popen(["sleep", "60"])
print(child.pid, flush=True)
"""


def _pid_alive(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat.rpartition(")")[2].split()[0] not in ("Z", "X")


async def _spawn_python(code: str, tmp_path: Path, **kwargs) -> asyncio.subprocess.Process:
    return await spawn_group(
        [sys.executable, "-c", code], cwd=tmp_path, env=os.environ, cli_label="Test", **kwargs
    )


async def _first_line(process: asyncio.subprocess.Process) -> bytes:
    assert process.stdout is not None
    return await asyncio.wait_for(process.stdout.readline(), 10)


async def test_terminate_group_stops_the_child_and_its_grandchildren(tmp_path: Path) -> None:
    process = await _spawn_python(_PARENT_WITH_GRANDCHILD, tmp_path)
    grandchild = int(await _first_line(process))
    assert os.getpgid(grandchild) == process.pid

    assert await terminate_group(process, 4.0) is True

    assert process.returncode is not None
    assert not group_alive(process.pid)
    await asyncio.sleep(0.1)
    assert not _pid_alive(grandchild)


async def test_reaping_a_finished_child_stops_what_it_left_behind(tmp_path: Path) -> None:
    process = await _spawn_python(_LEADER_LEAVES_A_GRANDCHILD, tmp_path)
    grandchild = int(await _first_line(process))

    assert await reap_group(process, 4.0) == 0

    assert not group_alive(process.pid)
    await asyncio.sleep(0.1)
    assert not _pid_alive(grandchild)


# Runs as a child subreaper that never reaps orphans, like PID 1 on a pod: the
# leader's background sleep is reparented to it and stays in the group as a zombie.
_NON_REAPING_INIT = """
import asyncio, ctypes, json, os, sys, time
from pathlib import Path
from sandbox_runtime.harness.cli_process import group_alive, spawn_group, terminate_group
PR_SET_CHILD_SUBREAPER = 36
assert ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0
async def main():
    process = await spawn_group(
        ["sh", "-c", "sleep 30 & exec sleep 30"],
        cwd=Path(sys.argv[1]), env=os.environ, cli_label="Test",
    )
    await asyncio.sleep(0.2)
    started = time.monotonic()
    stopped = await terminate_group(process, 4.0)
    elapsed = time.monotonic() - started
    zombies = [
        p.name for p in Path("/proc").iterdir() if p.name.isdigit()
        and (p / "stat").exists()
        and (p / "stat").read_text().rpartition(")")[2].split()[:3:2] == ["Z", str(process.pid)]
    ]
    print(json.dumps({"stopped": stopped, "elapsed": elapsed, "zombies": len(zombies),
                      "alive": group_alive(process.pid)}))
asyncio.run(main())
"""


async def test_a_zombie_left_in_the_group_does_not_keep_it_alive(tmp_path: Path) -> None:
    result = await asyncio.create_subprocess_exec(
        sys.executable, "-c", _NON_REAPING_INIT, str(tmp_path), stdout=asyncio.subprocess.PIPE
    )
    stdout, _ = await asyncio.wait_for(result.communicate(), 20)
    assert result.returncode == 0
    outcome = json.loads(stdout)
    assert outcome["zombies"] >= 1  # the case under test really happened
    assert outcome["stopped"] is True
    assert outcome["alive"] is False
    assert outcome["elapsed"] < 1.5


async def test_terminating_an_already_gone_group_is_a_success(tmp_path: Path) -> None:
    process = await _spawn_python("pass", tmp_path)
    await process.wait()
    await asyncio.sleep(0.05)
    assert await terminate_group(process, 1.0) is True


async def test_a_child_that_ignores_sigterm_is_killed(tmp_path: Path) -> None:
    code = (
        "import signal, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "time.sleep(60)\n"
    )
    process = await _spawn_python(code, tmp_path)
    await _first_line(process)
    log = _Log()

    assert await terminate_group(process, 0.4, log=log, log_prefix="grok") is True

    assert process.returncode is not None
    assert log.warnings == ["grok.terminate_timeout"]


async def test_the_inactivity_timeout_fires_on_a_silent_child(tmp_path: Path) -> None:
    code = "import time\nprint('one', flush=True)\ntime.sleep(60)\n"
    process = await _spawn_python(code, tmp_path)
    assert process.stdout is not None
    lines: list[bytes] = []
    try:
        with pytest.raises(InactivityTimeout) as raised:
            async for line in read_lines_with_inactivity(process.stdout, 0.3):
                lines.append(line)
    finally:
        await terminate_group(process, 2.0)
    assert lines == [b"one\n"]
    assert raised.value.seconds == 0.3


async def test_lines_up_to_the_limit_are_read_whole_and_longer_ones_refused(
    tmp_path: Path,
) -> None:
    assert STDOUT_LINE_LIMIT_BYTES == 16 * 1024 * 1024
    size = STDOUT_LINE_LIMIT_BYTES - 1
    code = (
        "import sys\n"
        f"sys.stdout.write('a' * {size} + '\\n')\n"
        f"sys.stdout.write('b' * {STDOUT_LINE_LIMIT_BYTES + 10} + '\\n')\n"
        "sys.stdout.flush()\n"
    )
    process = await _spawn_python(code, tmp_path)
    assert process.stdout is not None
    lines: list[int] = []
    try:
        with pytest.raises(LineTooLong):
            async for line in read_lines_with_inactivity(process.stdout, 10.0):
                lines.append(len(line))
    finally:
        await terminate_group(process, 2.0)
    assert lines == [size + 1]


async def test_the_stream_ends_at_eof(tmp_path: Path) -> None:
    process = await _spawn_python("print('a'); print('b')", tmp_path)
    assert process.stdout is not None
    lines = [line async for line in read_lines_with_inactivity(process.stdout, 10.0)]
    assert lines == [b"a\n", b"b\n"]
    assert await reap_group(process, 2.0) == 0


async def test_stdin_is_closed_unless_piped(tmp_path: Path) -> None:
    echo = "import sys\nprint(repr(sys.stdin.read()), flush=True)\n"
    silent = await _spawn_python(echo, tmp_path)
    assert await _first_line(silent) == b"''\n"
    await reap_group(silent, 2.0)

    piped = await _spawn_python(echo, tmp_path, stdin_pipe=True)
    assert piped.stdin is not None
    piped.stdin.write(b"prompt")
    piped.stdin.close()
    assert await _first_line(piped) == b"'prompt'\n"
    await reap_group(piped, 2.0)


async def test_the_stderr_tail_keeps_the_last_lines(tmp_path: Path) -> None:
    code = "import sys\nfor i in range(30):\n    print(f'line {i}', file=sys.stderr)\n"
    process = await _spawn_python(code, tmp_path)
    tail: collections.deque[str] = collections.deque(maxlen=3)
    seen: list[str] = []
    await read_stderr_tail(process.stderr, tail, on_line=seen.append)
    await reap_group(process, 2.0)
    assert list(tail) == ["line 27", "line 28", "line 29"]
    assert len(seen) == 30


async def test_a_missing_binary_is_a_start_error(tmp_path: Path) -> None:
    with pytest.raises(HarnessStartError, match="The SuperGrok CLI is not installed"):
        await spawn_group(
            [str(tmp_path / "no-such-grok")], cwd=tmp_path, env={}, cli_label="SuperGrok"
        )


async def test_the_child_runs_in_the_given_directory_with_the_given_env(tmp_path: Path) -> None:
    code = "import os\nprint(os.getcwd(), os.environ.get('ONLY_THIS'), flush=True)\n"
    process = await spawn_group(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env={"ONLY_THIS": "yes", "PATH": os.environ.get("PATH", "")},
        cli_label="Test",
    )
    assert (await _first_line(process)).decode().split() == [str(tmp_path), "yes"]
    await reap_group(process, 2.0)


class _Log:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warn(self, event: str, **_fields: object) -> None:
        self.warnings.append(event)
