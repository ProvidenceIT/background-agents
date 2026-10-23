"""GrokHarness against a fake ``grok`` executable, plus an opt-in live smoke.

The fake replays a recorded (scrubbed) ``streaming-json`` transcript and
records the argv and environment it was started with, so the tests assert
what really reaches the child: ``-p <text>`` (never ``-p -``), ``-s`` on a
new session and ``-r`` on a later turn, the pushed-token provider command and
no xAI key. Like grok, it keeps a session directory under ``$GROK_HOME``.

The live smoke runs the real ``~/.grok/bin/grok`` when ``OI_LIVE_GROK=1``
and ``OI_LIVE_GROK_AUTH_HOME`` names a home whose ``grok/access.json`` came
from ``sf-cred-push.sh --local-target`` (or an equivalent local helper).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness import AgentHarness, HarnessPrompt, HarnessStartError, PromptLimits
from sandbox_runtime.harness.base import (
    ANTHROPIC_MODEL_REFUSAL,
    NO_MODEL_SELECTED,
    GrokHarnessConfig,
    HarnessId,
)
from sandbox_runtime.harness.cli_process import group_alive
from sandbox_runtime.harness.grok import (
    PROMPT_ARGV_LIMIT_BYTES,
    SESSION_LOST_WARNING,
    GrokHarness,
    bare_grok_model,
    session_dir,
)

FIXTURES = Path(__file__).parent / "fixtures"
FAKE_TOKEN = "fake-grok-access-token-for-tests"
LIMITS = PromptLimits(
    inactivity_timeout_seconds=5.0,
    prompt_max_duration_seconds=30.0,
    prompt_cleanup_timeout_seconds=2.0,
)

FAKE_GROK = """#!{python}
import json, os, stat, subprocess, sys, time, urllib.parse
args = sys.argv[1:]
def opt(flag):
    # Like grok's clap parser: ``--flag=value`` or ``--flag value``, where a separate
    # value that starts with "-" is read as another flag.
    for index, arg in enumerate(args):
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1:]
        if arg == flag:
            value = args[index + 1]
            if value.startswith("-"):
                sys.stderr.write("error: unexpected argument '%s' found\\n" % value)
                sys.exit(2)
            return value
    return None
home = os.environ["GROK_HOME"]
session = opt("-s") or opt("-r")
cwd = opt("--cwd") or os.getcwd()
prompt_file = opt("--prompt-file")
for flag in ("--single", "--model", "--rules", "--reasoning-effort"):
    opt(flag)
file_info = None
if prompt_file:
    file_info = {{
        "mode": stat.S_IMODE(os.stat(prompt_file).st_mode),
        "bytes": os.path.getsize(prompt_file),
    }}
with open(os.environ["FAKE_GROK_RECORD"], "a") as handle:
    handle.write(json.dumps({{
        "argv": args,
        "env": {{k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}},
        "pid": os.getpid(),
        "pgid": os.getpgid(0),
        "prompt_file": file_info,
    }}) + "\\n")
restore_fail = os.environ.get("FAKE_GROK_RESTORE_FAIL")
if opt("-r") and restore_fail and os.path.exists(restore_fail):
    os.unlink(restore_fail)
    sys.stderr.write("Error: Failed to restore session from remote: session get failed: 404\\n")
    sys.exit(1)
if opt("-s"):
    os.makedirs(os.path.join(home, "sessions", urllib.parse.quote(cwd, safe=""), session))
sys.stderr.write(os.environ.get("FAKE_GROK_STDERR", ""))
sys.stderr.flush()
with open(os.environ["FAKE_GROK_TRANSCRIPT"]) as transcript:
    for line in transcript:
        if line.startswith("#sleep "):
            time.sleep(float(line.split()[1]))
            continue
        if line.startswith("#grandchild"):
            child = subprocess.Popen(["sleep", "300"])
            with open(os.environ["FAKE_GROK_RECORD"] + ".grandchild", "w") as handle:
                handle.write(str(child.pid))
            continue
        sys.stdout.write(line.replace("@SESSION_ID@", session or ""))
        sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_GROK_EXIT", "0")))
"""


def flag_value(argv: list[str], flag: str) -> str | None:
    """The value of ``flag`` in a recorded argv, given as ``flag=value`` or ``flag value``."""
    for index, arg in enumerate(argv):
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1 :]
        if arg == flag:
            return argv[index + 1]
    return None


class Rig:
    """A subscription home with a pushed token, a fake grok and a harness wired to both."""

    def __init__(self, tmp_path: Path, *, expires_in: float = 3600.0) -> None:
        self.tmp_path = tmp_path
        self.auth_home = tmp_path / ".sf-auth"
        self.write_token(expires_in)
        self.binary = tmp_path / "bin" / "grok"
        self.binary.parent.mkdir()
        self.binary.write_text(FAKE_GROK.format(python=sys.executable))
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.record = tmp_path / "record.jsonl"
        self.transcript = tmp_path / "transcript.ndjson"
        self.use("grok_turn.ndjson")
        self.workdir = tmp_path / "workspace"
        self.workdir.mkdir()
        self.grok_home = tmp_path / "grok-home"
        self.config_dir = tmp_path / "grok-config"
        self.environ = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(tmp_path),
            "SF_AUTH_HOME": str(self.auth_home),
            "SF_AUTH_HOME_PROVIDERS": "anthropic,xai",
            # Placeholders: the child must never see them.
            "XAI_API_KEY": "placeholder-xai-key",
            "GROK_AUTH_PATH": "/elsewhere/auth.json",
            "FAKE_GROK_RECORD": str(self.record),
            "FAKE_GROK_TRANSCRIPT": str(self.transcript),
        }
        self.events: list[dict[str, Any]] = []
        self.harness = self.build()

    def write_token(self, expires_in: float) -> None:
        now = time.time()
        (self.auth_home / "grok").mkdir(parents=True, exist_ok=True)
        (self.auth_home / "grok" / "access.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "provider": "xai",
                    "access_token": FAKE_TOKEN,
                    "expires_at": now + expires_in,
                    "pushed_at": now - 7200,
                    "source": "pc-test",
                    "account_tag": "abcd1234",
                }
            )
        )

    def use(self, fixture: str, *, extra: str = "") -> None:
        self.transcript.write_text(extra + (FIXTURES / fixture).read_text())

    def build(self, **config: Any) -> GrokHarness:
        return GrokHarness(
            config=GrokHarnessConfig(
                workdir=self.workdir,
                config_dir=self.config_dir,
                cli_home=self.grok_home,
                binary=str(self.binary),
                **config,
            ),
            log=MagicMock(),
            limits=LIMITS,
            environ=self.environ,
        )

    async def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def runs(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.record.read_text().splitlines()]


def prompt(text: str = "Reply with PONG", **fields: Any) -> HarnessPrompt:
    fields.setdefault("model", "xai/grok-4.7-build-fast")
    return HarnessPrompt(message_id="msg-1", text=text, **fields)


async def start(rig: Rig) -> GrokHarness:
    await rig.harness.open()
    await rig.harness.create_session()
    return rig.harness


def test_is_an_agent_harness(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    assert isinstance(rig.harness, AgentHarness)
    assert rig.harness.id is HarnessId.GROK


async def test_pong_turn_argv_env_and_outcome(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    harness = await start(rig)
    session_id = harness.session_id
    assert session_id is not None  # set before the turn, so the bridge persists it first
    outcome = await harness.run_prompt(prompt(reasoning_effort="high"), rig.emit)
    assert outcome.success
    assert outcome.message_cost_usd == pytest.approx(0.02184296)
    [run] = rig.runs()
    argv = run["argv"]
    assert "--single=Reply with PONG" in argv
    assert "-" not in argv and "-p" not in argv
    assert argv[argv.index("-s") + 1] == session_id
    assert "-r" not in argv
    for flag, value in (
        ("--output-format", "streaming-json"),
        ("--cwd", str(rig.workdir)),
        ("--model", "grok-4.7-build-fast"),
        ("--reasoning-effort", "high"),
    ):
        assert flag_value(argv, flag) == value
    assert "--always-approve" in argv
    assert "--no-auto-update" in argv
    assert "-c" not in argv and "--continue" not in argv
    env = run["env"]
    assert "XAI_API_KEY" not in env
    assert not [k for k in env if k.startswith("GROK_AUTH") and k != "GROK_AUTH_PROVIDER_COMMAND"]
    assert env["GROK_HOME"] == str(rig.grok_home)
    assert "sandbox_runtime.harness.grok_auth" in env["GROK_AUTH_PROVIDER_COMMAND"]
    assert env["GROK_DISABLE_AUTOUPDATER"] == "1"
    assert env["GROK_TELEMETRY_ENABLED"] == "0"
    assert FAKE_TOKEN not in json.dumps(run)
    assert [e["content"] for e in rig.events if e["type"] == "token"] == ["PO", "PONG"]
    assert harness.subscription_slot == "grok:abcd1234"
    assert not group_alive(run["pgid"])


async def test_second_turn_resumes_the_same_session(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    harness = await start(rig)
    session_id = harness.session_id
    assert (await harness.run_prompt(prompt(), rig.emit)).success
    assert (await harness.run_prompt(prompt("again"), rig.emit)).success
    first, second = rig.runs()
    assert first["argv"][first["argv"].index("-s") + 1] == session_id
    assert second["argv"][second["argv"].index("-r") + 1] == session_id
    assert "-s" not in second["argv"]
    assert harness.session_id == session_id
    # A restored bridge resumes the id grok keeps, and nothing else.
    restored = rig.build()
    assert await restored.resume_session(session_id or "")
    assert restored.session_id == session_id


async def test_resume_session_false_without_a_session_dir(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.harness.open()
    assert not await rig.harness.resume_session("22222222-2222-4222-8222-222222222222")
    assert not await rig.harness.resume_session("not-a-uuid")
    assert rig.harness.session_id is None
    assert session_dir(rig.grok_home, "22222222-2222-4222-8222-222222222222") is None


async def test_failed_restore_retries_once_fresh_with_a_warning(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    harness = await start(rig)
    assert (await harness.run_prompt(prompt(), rig.emit)).success
    old_id = harness.session_id
    marker = tmp_path / "restore-fail"
    marker.write_text("")
    rig.environ["FAKE_GROK_RESTORE_FAIL"] = str(marker)
    rig.events.clear()
    outcome = await harness.run_prompt(prompt("again"), rig.emit)
    assert outcome.success
    _, failed, retried = rig.runs()
    assert failed["argv"][failed["argv"].index("-r") + 1] == old_id
    new_id = retried["argv"][retried["argv"].index("-s") + 1]
    assert new_id != old_id
    assert harness.session_id == new_id
    warnings = [e for e in rig.events if e["type"] == "warning"]
    assert [w["message"] for w in warnings] == [SESSION_LOST_WARNING]
    assert not [e for e in rig.events if e["type"] == "error"]


async def test_large_prompt_goes_through_a_private_file_that_is_removed(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    harness = await start(rig)
    text = "x" * (PROMPT_ARGV_LIMIT_BYTES + 1)
    assert (await harness.run_prompt(prompt(text), rig.emit)).success
    [run] = rig.runs()
    assert flag_value(run["argv"], "--single") is None
    path = Path(flag_value(run["argv"], "--prompt-file") or "")
    assert run["prompt_file"] == {"mode": 0o600, "bytes": len(text)}
    assert not path.exists()


async def test_tool_turn(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.use("grok_tool_turn.ndjson")
    harness = await start(rig)
    assert (await harness.run_prompt(prompt("ls"), rig.emit)).success
    tools = [(e["tool"], e["status"]) for e in rig.events if e["type"] == "tool_call"]
    assert tools == [
        ("bash", "running"),
        ("bash", "completed"),
        ("memory_read", "running"),
        ("memory_read", "error"),
    ]


async def test_not_signed_in_fails_as_auth(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.use("grok_fail.ndjson")
    rig.environ["FAKE_GROK_EXIT"] = "1"
    harness = await start(rig)
    outcome = await harness.run_prompt(prompt(), rig.emit)
    assert not outcome.success
    assert "SuperGrok was refused" in (outcome.error or "")
    assert "sf-cred-push.timer" in (outcome.error or "")
    assert outcome.limit is None


async def test_429_on_stderr_is_a_subscription_limit(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.transcript.write_text("")
    rig.environ["FAKE_GROK_STDERR"] = "Error: 429 Too Many Requests: usage limit reached\n"
    rig.environ["FAKE_GROK_EXIT"] = "1"
    harness = await start(rig)
    outcome = await harness.run_prompt(prompt(), rig.emit)
    assert not outcome.success
    assert outcome.limit is not None
    assert outcome.limit.window == "unknown"
    assert rig.events[-1]["type"] == "error"


async def test_stale_push_fails_the_turn_without_starting_grok(tmp_path: Path) -> None:
    rig = Rig(tmp_path, expires_in=300)
    harness = await start(rig)
    outcome = await harness.run_prompt(prompt(), rig.emit)
    assert not outcome.success
    assert "SuperGrok credential push stale since" in (outcome.error or "")
    assert FAKE_TOKEN not in (outcome.error or "")
    assert not rig.record.exists()


async def test_open_needs_an_enrolled_home(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.environ["SF_AUTH_HOME_PROVIDERS"] = "anthropic"
    with pytest.raises(HarnessStartError, match="not enrolled"):
        await rig.harness.open()


async def test_open_writes_config_with_the_oi_server(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    tool_config = tmp_path / "oi-tools.json"
    harness = rig.build(tool_config_path=tool_config, memory_text="Remember: tabs.")
    await harness.open()
    config = (rig.grok_home / "config.toml").read_text()
    assert "[mcp_servers.oi]" in config
    assert str(tool_config) in config
    await harness.create_session()
    assert (await harness.run_prompt(prompt(), rig.emit)).success
    [run] = rig.runs()
    assert "--rules=Remember: tabs." in run["argv"]


@pytest.mark.parametrize("text", ["- fix the bug\n- then the tests", "--rules"])
async def test_prompt_and_memory_that_start_with_a_dash_stay_values(
    tmp_path: Path, text: str
) -> None:
    rig = Rig(tmp_path)
    harness = rig.build(memory_text="- prefer tabs")
    await harness.open()
    await harness.create_session()
    assert (await harness.run_prompt(prompt(text), rig.emit)).success
    [run] = rig.runs()
    assert flag_value(run["argv"], "--single") == text
    assert flag_value(run["argv"], "--rules") == "- prefer tabs"


@pytest.mark.parametrize(
    ("model", "error"),
    [
        ("anthropic/claude-opus-5-5", ANTHROPIC_MODEL_REFUSAL),
        ("claude-sonnet-4-6", ANTHROPIC_MODEL_REFUSAL),
        ("openai/gpt-6.1-sol", "cannot run provider 'openai'"),
    ],
)
async def test_foreign_models_are_refused_before_a_child(
    tmp_path: Path, model: str, error: str
) -> None:
    rig = Rig(tmp_path)
    harness = await start(rig)
    outcome = await harness.run_prompt(prompt(model=model), rig.emit)
    assert not outcome.success
    assert error in (outcome.error or "")
    assert not rig.record.exists()


def test_bare_grok_model() -> None:
    assert bare_grok_model("xai/grok-4.6", "xai/grok-4.7") == "grok-4.6"
    assert bare_grok_model(None, "xai/grok-4.7") == "grok-4.7"
    assert bare_grok_model("grok-4.5", "") == "grok-4.5"
    with pytest.raises(ValueError, match=NO_MODEL_SELECTED):
        bare_grok_model(None, "")


async def test_abort_kills_the_group_and_cancels(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    tool_start = (FIXTURES / "grok_tool_turn.ndjson").read_text().splitlines()[:3]
    rig.transcript.write_text("\n".join(tool_start) + "\n#grandchild\n#sleep 30\n")
    harness = await start(rig)
    task = asyncio.create_task(harness.run_prompt(prompt("ls"), rig.emit))
    for _ in range(200):
        if any(e["type"] == "tool_call" for e in rig.events):
            break
        await asyncio.sleep(0.05)
    assert any(e["type"] == "tool_call" for e in rig.events)
    grandchild_file = Path(str(rig.record) + ".grandchild")
    for _ in range(100):
        if grandchild_file.exists():
            break
        await asyncio.sleep(0.05)
    assert await harness.abort()
    outcome = await asyncio.wait_for(task, 10)
    assert outcome.cancelled
    [run] = rig.runs()
    assert not group_alive(run["pgid"])
    grandchild = int(grandchild_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(grandchild, 0)
    assert not await harness.abort()


async def test_inactivity_timeout_kills_the_child(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.transcript.write_text("#sleep 30\n")
    harness = GrokHarness(
        config=GrokHarnessConfig(
            workdir=rig.workdir,
            config_dir=rig.config_dir,
            cli_home=rig.grok_home,
            binary=str(rig.binary),
        ),
        log=MagicMock(),
        limits=PromptLimits(
            inactivity_timeout_seconds=0.5,
            prompt_max_duration_seconds=30.0,
            prompt_cleanup_timeout_seconds=2.0,
        ),
        environ=rig.environ,
    )
    await harness.open()
    await harness.create_session()
    outcome = await harness.run_prompt(prompt(), rig.emit)
    assert not outcome.success
    assert "no output for" in (outcome.error or "")
    [run] = rig.runs()
    assert not group_alive(run["pgid"])


# --- live smoke ------------------------------------------------------------

LIVE = os.environ.get("OI_LIVE_GROK") == "1"
LIVE_BINARY = Path(os.environ.get("OI_LIVE_GROK_BINARY", str(Path.home() / ".grok/bin/grok")))


def live_rig(tmp_path: Path, **config: Any) -> tuple[GrokHarness, list[dict[str, Any]], Path]:
    auth_home = os.environ.get("OI_LIVE_GROK_AUTH_HOME")
    if not auth_home:
        pytest.skip("OI_LIVE_GROK_AUTH_HOME names the home holding grok/access.json")
    root = Path(os.environ.get("OI_LIVE_GROK_SCRATCH", str(tmp_path)))
    root.mkdir(parents=True, exist_ok=True)
    workdir = root / "workspace"
    workdir.mkdir(exist_ok=True)
    (workdir / "hello.txt").write_text("hi\n")
    grok_home = root / "grok-home"
    environ = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(("OI_LIVE_", "PYTEST_"))
    }
    environ.update({"SF_AUTH_HOME": auth_home, "SF_AUTH_HOME_PROVIDERS": "xai"})
    events: list[dict[str, Any]] = []
    harness = GrokHarness(
        config=GrokHarnessConfig(
            workdir=workdir,
            config_dir=root / "grok-config",
            cli_home=grok_home,
            binary=str(LIVE_BINARY),
            **config,
        ),
        log=MagicMock(),
        limits=PromptLimits(
            inactivity_timeout_seconds=300.0,
            prompt_max_duration_seconds=300.0,
            prompt_cleanup_timeout_seconds=5.0,
        ),
        environ=environ,
    )
    return harness, events, grok_home


def survivors(grok_home: Path) -> list[str]:
    """Processes started for this GROK_HOME: by command line (pgrep) or environment."""
    found = subprocess.run(
        ["pgrep", "-af", str(grok_home)], capture_output=True, text=True, check=False
    ).stdout.splitlines()
    marker = f"GROK_HOME={grok_home}".encode()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if marker in (proc / "environ").read_bytes().split(b"\0"):
                found.append(f"{proc.name} {(proc / 'cmdline').read_bytes()[:200]!r}")
        except OSError:
            continue
    return [line for line in found if "pgrep" not in line]


@pytest.mark.skipif(not LIVE, reason="live grok smoke runs only with OI_LIVE_GROK=1")
async def test_live_pong_tool_resume_and_abort(tmp_path: Path) -> None:
    tool_config = tmp_path / "oi-tools.json"
    tool_config.write_text(
        json.dumps(
            {
                # Nothing listens there: the call fails, but its name and shape are real.
                "control_plane_url": "http://127.0.0.1:9",
                "session_id": "sess-live-smoke",
                "auth_token": "placeholder",
                "repo_manifest_path": str(tmp_path / "none.json"),
                "has_repository": False,
                "slack_notify_enabled": False,
            }
        )
    )
    tool_config.chmod(0o600)
    harness, events, grok_home = live_rig(tmp_path, tool_config_path=tool_config)

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    await harness.open()
    await harness.create_session()
    session_id = harness.session_id

    outcome = await harness.run_prompt(
        prompt("Remember the code word ZEBRA. Reply with exactly: PONG"), emit
    )
    assert outcome.success, outcome.error
    tokens = [e["content"] for e in events if e["type"] == "token"]
    assert tokens and "PONG" in tokens[-1]
    assert all(later.startswith(earlier) for earlier, later in itertools.pairwise(tokens))
    assert harness.subscription_slot and harness.subscription_slot.startswith("grok:")

    events.clear()
    outcome = await harness.run_prompt(
        prompt(
            "Run `ls` in the shell, then call the oi__memory_read tool once with "
            'memoryId "smoke", then reply DONE.'
        ),
        emit,
    )
    assert outcome.success, outcome.error
    tools = [(e["tool"], e["status"]) for e in events if e["type"] == "tool_call"]
    assert ("bash", "running") in tools and ("bash", "completed") in tools
    assert any(name == "memory_read" for name, _ in tools), tools
    assert harness.session_id == session_id

    events.clear()
    outcome = await harness.run_prompt(prompt("What was the code word? One word."), emit)
    assert outcome.success, outcome.error
    assert "ZEBRA" in [e["content"] for e in events if e["type"] == "token"][-1].upper()
    assert harness.session_id == session_id

    events.clear()
    task = asyncio.create_task(
        harness.run_prompt(prompt("Run `sleep 120` in the shell, then reply DONE."), emit)
    )
    for _ in range(1200):
        if any(e["type"] == "tool_call" and e["status"] == "running" for e in events):
            break
        await asyncio.sleep(0.1)
    assert any(e["type"] == "tool_call" for e in events), events
    await asyncio.sleep(1.0)
    assert await harness.abort()
    outcome = await asyncio.wait_for(task, 30)
    assert outcome.cancelled
    await harness.close()
    assert survivors(grok_home) == []
