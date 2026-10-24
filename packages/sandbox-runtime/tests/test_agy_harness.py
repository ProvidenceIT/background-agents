"""AgyHarness against a fake ``agy`` executable, plus an opt-in live smoke.

The fake replays a recorded ``agy --output-format stream-json`` transcript (or
a scripted one) and records the argv, environment, ``HOME``, stdin and the
token file it saw, so the tests assert what really reaches the child: an
access-only login, no Google credentials, the prompt on argv or on one stdin
line, and ``--conversation <id>`` on a later turn.

``OI_LIVE_AGY=1`` runs ``TestLiveAgy`` against the real ``agy`` on PATH with
a scratch ``HOME`` and an access-only token built from the owner's local
``~/.cache/fm-quota-agy/access.json`` (never printed).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness import AgentHarness, HarnessPrompt, HarnessStartError, PromptLimits
from sandbox_runtime.harness import agy as agy_module
from sandbox_runtime.harness.agy import (
    PROMPT_ARGV_LIMIT_BYTES,
    AgyHarness,
    ModelRefused,
    model_args,
)
from sandbox_runtime.harness.agy_translate import LOST_CONVERSATION_WARNING
from sandbox_runtime.harness.base import (
    ANTHROPIC_MODEL_REFUSAL,
    NO_MODEL_SELECTED,
    AgyHarnessConfig,
    HarnessId,
)

TRANSCRIPT = Path(__file__).parent / "fixtures" / "agy_turn.ndjson"
CONVERSATION = "11111111-2222-4333-8444-555555555555"
OTHER_CONVERSATION = "99999999-8888-4777-8666-555555555555"
FAKE_ACCESS = "fake-access-token-not-real"
LIMITS = PromptLimits(
    inactivity_timeout_seconds=5.0,
    prompt_max_duration_seconds=30.0,
    prompt_cleanup_timeout_seconds=2.0,
)

FAKE_AGY = """#!{python}
import json, os, stat, sys, time
token_path = os.path.join(os.environ["HOME"], ".gemini/antigravity-cli/antigravity-oauth-token")
mcp_path = os.path.join(os.environ["HOME"], ".gemini/config/mcp_config.json")
record = os.environ["FAKE_AGY_RECORD"]

def token():
    with open(token_path) as handle:
        return {{"mode": stat.S_IMODE(os.stat(token_path).st_mode), "payload": json.load(handle)}}

def dump(**extra):
    with open(record, "a") as handle:
        handle.write(json.dumps({{"pid": os.getpid(), **extra}}) + "\\n")

stdin = sys.stdin.readline() if "--input-format" in sys.argv else ""
dump(
    argv=sys.argv[1:],
    env={{k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}},
    home=os.environ["HOME"],
    cwd=os.getcwd(),
    stdin=stdin,
    stdin_rest=sys.stdin.read() if stdin else "",
    token=token(),
    mcp=json.load(open(mcp_path)) if os.path.exists(mcp_path) else None,
)
with open(os.environ["FAKE_AGY_TRANSCRIPT"]) as transcript:
    for line in transcript:
        if line.startswith("#sleep "):
            time.sleep(float(line.split()[1]))
            continue
        if line.startswith("#stderr "):
            sys.stderr.write(line[len("#stderr "):])
            sys.stderr.flush()
            continue
        if line.startswith("#token"):
            dump(token=token())
            continue
        if line.startswith("#spawn "):
            # agy runs a command on its own terminal: a session of its own.
            import subprocess
            child = subprocess.Popen(["sleep", line.split()[1]], start_new_session=True)
            dump(grandchild=child.pid)
            continue
        if line.startswith("#interrupt"):
            # agy answers SIGTERM with an "interrupted" result, then exits.
            import signal
            def interrupted(*_):
                sys.stdout.write(json.dumps({{"event": "result", "result": {{
                    "conversation_id": "", "status": "ERROR", "error": "interrupted"}}}}) + "\\n")
                sys.stdout.flush()
                os._exit(1)
            signal.signal(signal.SIGTERM, interrupted)
            continue
        if '"init"' in line:
            # agy keeps each conversation it starts or resumes in a database.
            conversations = os.path.join(os.environ["HOME"], ".gemini/antigravity-cli/conversations")
            os.makedirs(conversations, exist_ok=True)
            open(os.path.join(conversations, json.loads(line)["conversation_id"] + ".db"), "a").close()
        sys.stdout.write(line)
        sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_AGY_EXIT", "0")))
"""


def access_json(expires_in: float, access_token: str = FAKE_ACCESS) -> str:
    return json.dumps(
        {
            "schema": 1,
            "provider": "antigravity",
            "access_token": access_token,
            "expires_at": time.time() + expires_in,
            "pushed_at": 1_790_000_000,
            "source": "pc-test",
            "account_tag": "abcd1234",
        }
    )


class Rig:
    """A subscription home with a pushed token, a fake agy and a harness wired to both."""

    def __init__(
        self, tmp_path: Path, *, expires_in: float = 3000.0, providers: str = "antigravity"
    ):
        self.tmp_path = tmp_path
        self.auth_home = tmp_path / ".sf-auth"
        (self.auth_home / "agy").mkdir(parents=True)
        self.push(expires_in)
        self.home = tmp_path / "home"
        self.home.mkdir()
        self.binary = tmp_path / "bin" / "agy"
        self.binary.parent.mkdir()
        self.binary.write_text(FAKE_AGY.format(python=sys.executable))
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.record = tmp_path / "record.jsonl"
        self.transcript = tmp_path / "transcript.ndjson"
        self.transcript.write_text(TRANSCRIPT.read_text())
        self.workdir = tmp_path / "workspace"
        self.workdir.mkdir()
        self.environ = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.home),
            "SF_AUTH_HOME": str(self.auth_home),
            "SF_AUTH_HOME_PROVIDERS": providers,
            # Placeholders: the child must never see any of these.
            "GEMINI_API_KEY": "placeholder-gemini-key",
            "GOOGLE_API_KEY": "placeholder-google-key",
            "GOOGLE_APPLICATION_CREDENTIALS": "/placeholder.json",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/placeholder",
            "DISPLAY": ":99",
            "FAKE_AGY_RECORD": str(self.record),
            "FAKE_AGY_TRANSCRIPT": str(self.transcript),
        }
        self.events: list[dict[str, Any]] = []
        self.harness = self.build()

    def push(self, expires_in: float, access_token: str = FAKE_ACCESS) -> None:
        (self.auth_home / "agy" / "access.json").write_text(access_json(expires_in, access_token))

    def build(self, **config: Any) -> AgyHarness:
        config.setdefault("tool_config_path", self.tmp_path / "cfg" / "oi-tools.json")
        config.setdefault("binary", str(self.binary))
        return AgyHarness(
            config=AgyHarnessConfig(
                workdir=self.workdir,
                config_dir=self.tmp_path / "cfg",
                cli_home=self.home,
                **config,
            ),
            log=MagicMock(),
            limits=LIMITS,
            environ=self.environ,
            token_rewrite_seconds=0.1,
        )

    async def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)

    def runs(self) -> list[dict[str, Any]]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines()]

    def starts(self) -> list[dict[str, Any]]:
        return [run for run in self.runs() if "argv" in run]

    def script(self, *lines: str) -> None:
        self.transcript.write_text("\n".join(lines) + "\n")


def prompt(text: str = "What is in this repository?", **fields: Any) -> HarnessPrompt:
    fields.setdefault("model", "antigravity/gemini-4-argon")
    return HarnessPrompt(message_id="msg-1", text=text, **fields)


def init_line(conversation: str = CONVERSATION) -> str:
    return json.dumps({"event": "init", "conversation_id": conversation, "init": {}})


def result_line(conversation: str = CONVERSATION, status: str = "SUCCESS", **fields: Any) -> str:
    return json.dumps(
        {
            "event": "result",
            "result": {"conversation_id": conversation, "status": status, **fields},
        }
    )


def conversation_db(rig: Rig, conversation: str) -> None:
    directory = rig.home / ".gemini" / "antigravity-cli" / "conversations"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{conversation}.db").write_bytes(b"")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie no one reaped yet is gone for our purposes.
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except OSError:
        return False


@pytest.fixture
async def rig(tmp_path: Path) -> Rig:
    rig = Rig(tmp_path)
    await rig.harness.open()
    return rig


class TestModelArgs:
    def test_gemini_with_an_effort(self):
        assert model_args("antigravity/gemini-4-argon", "high") == [
            "--model",
            "gemini-4-argon",
            "--effort",
            "high",
        ]

    def test_without_an_effort(self):
        assert model_args("antigravity/gemini-3.8-flash", None) == ["--model", "gemini-3.8-flash"]

    def test_gpt_oss_has_its_effort_in_the_id(self):
        assert model_args("antigravity/gpt-oss-120b", "high") == ["--model", "gpt-oss-120b-medium"]

    @pytest.mark.parametrize(
        "model",
        ["antigravity/claude-opus-5-5", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"],
    )
    def test_claude_is_refused(self, model: str):
        with pytest.raises(ModelRefused, match="Claude Agent"):
            model_args(model, None)

    def test_other_providers_are_refused(self):
        with pytest.raises(ModelRefused, match="cannot run provider 'openai'"):
            model_args("openai/gpt-6.1-sol", None)

    def test_no_model(self):
        with pytest.raises(ModelRefused, match=NO_MODEL_SELECTED):
            model_args("", None)


class TestHarness:
    async def test_conforms_to_the_seam(self, rig: Rig):
        assert isinstance(rig.harness, AgentHarness)
        assert rig.harness.id is HarnessId.AGY

    async def test_a_recorded_turn_streams_and_adopts_the_conversation(self, rig: Rig):
        await rig.harness.create_session()
        outcome = await rig.harness.run_prompt(prompt(reasoning_effort="high"), rig.emit)
        assert outcome.success
        assert rig.harness.session_id == CONVERSATION
        assert rig.harness.subscription_slot == "agy-abcd1234"
        # The shared subscriptionSlotSchema; the control plane drops a completion that breaks it.
        assert re.fullmatch(r"[A-Za-z0-9._-]{1,64}", rig.harness.subscription_slot)
        types = [e["type"] for e in rig.events]
        assert types[0] == "step_start" and types[-1] == "step_finish"
        assert [e["content"] for e in rig.events if e["type"] == "token"][-1] == (
            "README.md\nsrc\ntests"
        )
        (start,) = rig.starts()
        argv = start["argv"]
        assert argv[:2] == ["-p", "What is in this repository?"]
        assert argv[argv.index("--model") : argv.index("--model") + 4] == [
            "--model",
            "gemini-4-argon",
            "--effort",
            "high",
        ]
        assert "--output-format" in argv and "stream-json" in argv
        assert "--dangerously-skip-permissions" in argv
        assert "--conversation" not in argv and "--input-format" not in argv
        assert "--print-timeout" not in argv
        assert start["cwd"] == str(rig.workdir)

    async def test_the_child_sees_an_access_only_token_and_no_google_credentials(self, rig: Rig):
        await rig.harness.run_prompt(prompt(), rig.emit)
        (start,) = rig.starts()
        assert start["home"] == str(rig.home)
        env = start["env"]
        assert not any(name.startswith("GOOGLE_") for name in env)
        for name in ("GEMINI_API_KEY", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY"):
            assert name not in env
        assert env["BROWSER"] == "/bin/false"
        assert start["token"]["mode"] == 0o600
        payload = start["token"]["payload"]
        assert payload["token"]["access_token"] == FAKE_ACCESS
        assert "refresh_token" not in payload["token"] and "id_token" not in payload
        assert "refresh_token" not in json.dumps(payload)

    async def test_open_writes_the_oi_mcp_config(self, rig: Rig):
        await rig.harness.run_prompt(prompt(), rig.emit)
        (start,) = rig.starts()
        server = start["mcp"]["mcpServers"]["oi"]
        assert server["command"] == sys.executable
        assert server["args"] == [
            "-m",
            "sandbox_runtime.harness.codex_tools",
            str(rig.tmp_path / "cfg" / "oi-tools.json"),
        ]
        assert server["disabled"] is False

    async def test_gpt_oss_runs_without_an_effort(self, rig: Rig):
        await rig.harness.run_prompt(
            prompt(model="antigravity/gpt-oss-120b", reasoning_effort="high"), rig.emit
        )
        argv = rig.starts()[0]["argv"]
        assert "gpt-oss-120b-medium" in argv and "--effort" not in argv

    @pytest.mark.parametrize(
        "model", ["antigravity/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6-sol"]
    )
    async def test_refused_models_never_spawn(self, rig: Rig, model: str):
        outcome = await rig.harness.run_prompt(prompt(model=model), rig.emit)
        assert not outcome.success
        if "openai" not in model:
            assert outcome.error == ANTHROPIC_MODEL_REFUSAL
        assert rig.starts() == []

    async def test_a_large_prompt_goes_in_as_one_stdin_line(self, rig: Rig):
        text = "x" * (PROMPT_ARGV_LIMIT_BYTES + 1)
        outcome = await rig.harness.run_prompt(prompt(text), rig.emit)
        assert outcome.success
        (start,) = rig.starts()
        argv = start["argv"]
        assert argv[:2] == ["-p", ""]
        assert argv[argv.index("--input-format") + 1] == "stream-json"
        assert json.loads(start["stdin"]) == {
            "event": "user",
            "message": {"role": "user", "content": text},
        }
        assert start["stdin_rest"] == ""  # exactly one line, then EOF

    async def test_a_prompt_at_the_limit_stays_on_argv(self, rig: Rig):
        text = "y" * PROMPT_ARGV_LIMIT_BYTES
        await rig.harness.run_prompt(prompt(text), rig.emit)
        argv = rig.starts()[0]["argv"]
        assert argv[:2] == ["-p", text] and "--input-format" not in argv

    async def test_memory_leads_the_first_turn_only(self, tmp_path: Path):
        rig = Rig(tmp_path)
        rig.harness = rig.build(memory_text="Use tabs.")
        await rig.harness.open()
        await rig.harness.run_prompt(prompt("hello"), rig.emit)
        await rig.harness.run_prompt(prompt("again"), rig.emit)
        first, second = (start["argv"][1] for start in rig.starts())
        assert first.startswith("Use tabs.") and first.endswith("hello")
        assert second == "again"

    async def test_the_next_turn_resumes_the_conversation(self, rig: Rig):
        await rig.harness.run_prompt(prompt(), rig.emit)
        await rig.harness.run_prompt(prompt("and now?"), rig.emit)
        second = rig.starts()[1]["argv"]
        assert second[second.index("--conversation") + 1] == CONVERSATION
        assert not [e for e in rig.events if e["type"] == "warning"]

    async def test_a_lost_conversation_warns_and_adopts_the_new_id(self, rig: Rig):
        rig.harness.session_id = OTHER_CONVERSATION
        conversation_db(rig, OTHER_CONVERSATION)
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert outcome.success
        argv = rig.starts()[0]["argv"]
        assert argv[argv.index("--conversation") + 1] == OTHER_CONVERSATION
        assert rig.harness.session_id == CONVERSATION
        warnings = [e["message"] for e in rig.events if e["type"] == "warning"]
        assert warnings == [LOST_CONVERSATION_WARNING]

    async def test_memory_follows_a_conversation_agy_lost(self, tmp_path: Path):
        rig = Rig(tmp_path)
        rig.harness = rig.build(memory_text="Use tabs.")
        await rig.harness.open()
        rig.harness.session_id = OTHER_CONVERSATION
        conversation_db(rig, OTHER_CONVERSATION)
        await rig.harness.run_prompt(prompt("hello"), rig.emit)
        await rig.harness.run_prompt(prompt("again"), rig.emit)
        await rig.harness.run_prompt(prompt("third"), rig.emit)
        # agy answered the resume with a fresh conversation: its next prompt carries the notes.
        first, second, third = (start["argv"][1] for start in rig.starts())
        assert first == "hello"
        assert second.startswith("Use tabs.") and second.endswith("again")
        assert third == "third"

    async def test_a_conversation_gone_from_disk_starts_fresh_with_memory(self, tmp_path: Path):
        rig = Rig(tmp_path)
        rig.harness = rig.build(memory_text="Use tabs.")
        await rig.harness.open()
        rig.harness.session_id = OTHER_CONVERSATION
        outcome = await rig.harness.run_prompt(prompt("hello"), rig.emit)
        assert outcome.success
        argv = rig.starts()[0]["argv"]
        assert "--conversation" not in argv
        assert argv[1].startswith("Use tabs.") and argv[1].endswith("hello")
        assert rig.harness.session_id == CONVERSATION
        warnings = [e["message"] for e in rig.events if e["type"] == "warning"]
        assert warnings == [LOST_CONVERSATION_WARNING]

    async def test_resume_needs_the_conversation_database(self, rig: Rig):
        assert not await rig.harness.resume_session(CONVERSATION)
        directory = rig.home / ".gemini" / "antigravity-cli" / "conversations"
        directory.mkdir(parents=True)
        (directory / f"{CONVERSATION}.db").write_bytes(b"")
        assert await rig.harness.resume_session(CONVERSATION)
        assert rig.harness.session_id == CONVERSATION

    async def test_the_token_file_is_rewritten_during_a_slow_turn(self, rig: Rig):
        rig.script(init_line(), "#sleep 0.6", "#token", result_line())
        task = asyncio.create_task(rig.harness.run_prompt(prompt(), rig.emit))
        await asyncio.sleep(0.25)
        rig.push(3500, access_token="fake-access-token-second")
        outcome = await task
        assert outcome.success
        start, later = rig.runs()
        assert start["token"]["payload"]["token"]["access_token"] == FAKE_ACCESS
        assert later["token"]["payload"]["token"]["access_token"] == "fake-access-token-second"
        assert later["token"]["mode"] == 0o600

    async def test_under_ten_minutes_left_is_refused_before_spawn(self, tmp_path: Path):
        rig = Rig(tmp_path, expires_in=590)
        await rig.harness.open()
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert not outcome.success
        assert "Antigravity credential push stale since" in (outcome.error or "")
        assert FAKE_ACCESS not in (outcome.error or "")
        assert rig.starts() == []

    async def test_a_home_not_enrolled_cannot_open(self, tmp_path: Path):
        rig = Rig(tmp_path, providers="anthropic,openai")
        with pytest.raises(HarnessStartError, match="not enrolled"):
            await rig.harness.open()

    async def test_the_deadline_is_capped_at_the_token_expiry(
        self, rig: Rig, monkeypatch: pytest.MonkeyPatch
    ):
        # 3000s left on the token; a margin of 2999s leaves the turn about one second.
        monkeypatch.setattr(agy_module, "TOKEN_EXPIRY_MARGIN_SECONDS", 2999.0)
        rig.script(init_line(), "#sleep 10", result_line())
        started = time.monotonic()
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert time.monotonic() - started < 5
        assert not outcome.success
        assert "before the pushed Antigravity login expires" in (outcome.error or "")
        assert not alive(rig.starts()[0]["pid"])

    async def test_a_login_prompt_on_stderr_ends_the_turn_at_once(self, rig: Rig):
        rig.script(
            "#stderr Authentication required. Please visit the URL to log in:",
            "#stderr Waiting for authentication (timeout 60s)...",
            "#sleep 30",
            result_line(conversation="", status="ERROR", error="authentication failed"),
        )
        started = time.monotonic()
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert time.monotonic() - started < 2
        assert not outcome.success
        assert "refused the pushed login" in (outcome.error or "")
        assert "credential push stale since" in (outcome.error or "")
        assert not alive(rig.starts()[0]["pid"])

    async def test_a_non_success_result_fails_and_denied_actions_warn(self, rig: Rig):
        rig.transcript.write_text((TRANSCRIPT.parent / "agy_fail.ndjson").read_text())
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert not outcome.success and not outcome.cancelled
        assert "model stream ended unexpectedly" in (outcome.error or "")
        assert any(e["type"] == "warning" and "denied" in e["message"] for e in rig.events)

    async def test_an_exit_without_a_result_fails_with_the_stderr_tail(self, rig: Rig):
        rig.script(init_line(), "#stderr error: something broke")
        rig.environ["FAKE_AGY_EXIT"] = "1"
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert not outcome.success
        assert "exited with code 1" in (outcome.error or "")
        assert "something broke" in (outcome.error or "")

    async def test_abort_cancels_the_turn_and_leaves_no_survivors(self, rig: Rig):
        rig.script(init_line(), "#interrupt", "#spawn 30", "#sleep 30", result_line())
        task = asyncio.create_task(rig.harness.run_prompt(prompt(), rig.emit))
        for _ in range(100):
            if any("grandchild" in run for run in rig.runs()):
                break
            await asyncio.sleep(0.05)
        assert await rig.harness.abort()
        outcome = await task
        assert outcome.cancelled and not outcome.success
        runs = rig.runs()
        grandchild = next(run["grandchild"] for run in runs if "grandchild" in run)
        assert not alive(runs[0]["pid"])
        assert not alive(grandchild)

    async def test_an_agy_that_lingers_after_its_result_is_stopped_tree_and_all(self, rig: Rig):
        rig.script(init_line(), "#spawn 30", result_line(), "#sleep 30")
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert outcome.success
        runs = rig.runs()
        grandchild = next(run["grandchild"] for run in runs if "grandchild" in run)
        assert not alive(runs[0]["pid"])
        assert not alive(grandchild)

    async def test_a_command_agy_detached_is_stopped_after_agy_exits(self, rig: Rig):
        # agy exits at once after its result; the detached command has gone to init.
        rig.script(init_line(), "#spawn 30", "#sleep 1", result_line())
        outcome = await rig.harness.run_prompt(prompt(), rig.emit)
        assert outcome.success
        grandchild = next(run["grandchild"] for run in rig.runs() if "grandchild" in run)
        for _ in range(40):
            if not alive(grandchild):
                break
            await asyncio.sleep(0.05)
        assert not alive(grandchild)

    async def test_cancelling_the_turn_kills_agy(self, rig: Rig):
        rig.script(init_line(), "#sleep 30", result_line())
        task = asyncio.create_task(rig.harness.run_prompt(prompt(), rig.emit))
        for _ in range(100):
            if rig.starts():
                break
            await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not alive(rig.starts()[0]["pid"])

    async def test_a_missing_binary_is_a_start_error(self, rig: Rig):
        rig.harness = rig.build(binary=str(rig.tmp_path / "missing" / "agy"))
        await rig.harness.open()
        with pytest.raises(HarnessStartError, match="agy CLI is not installed"):
            await rig.harness.run_prompt(prompt(), rig.emit)


# --- live smoke ------------------------------------------------------------------

LIVE = os.environ.get("OI_LIVE_AGY") == "1"
LIVE_SOURCE = Path.home() / ".cache" / "fm-quota-agy" / "access.json"
LIVE_MODEL = os.environ.get("OI_LIVE_AGY_MODEL", "antigravity/gemini-3.8-flash")


def _agy_pids() -> set[int]:
    found = subprocess.run(["pgrep", "-x", "agy"], capture_output=True, text=True, check=False)
    return {int(pid) for pid in found.stdout.split()}


@pytest.mark.skipif(not LIVE, reason="set OI_LIVE_AGY=1 to run against the real agy")
class TestLiveAgy:
    """The real agy on a scratch HOME; token values are never printed."""

    @pytest.fixture
    def live(self, tmp_path: Path) -> Rig:
        source = json.loads(LIVE_SOURCE.read_text())
        if source["expires_at"] - time.time() < 900:
            pytest.skip("the local agy access token has under 15 minutes left")
        root = os.environ.get("OI_LIVE_AGY_DIR")
        scratch = Path(root) / tmp_path.name if root else tmp_path
        scratch.mkdir(parents=True, exist_ok=True)
        rig = Rig(scratch)
        rig.push(source["expires_at"] - time.time(), access_token=source["access_token"])
        rig.environ = {
            name: value
            for name, value in os.environ.items()
            if name not in ("SF_AUTH_HOME", "SF_AUTH_HOME_PROVIDERS")
        }
        rig.environ.update(
            {"SF_AUTH_HOME": str(rig.auth_home), "SF_AUTH_HOME_PROVIDERS": "antigravity"}
        )
        rig.harness = AgyHarness(
            config=AgyHarnessConfig(
                workdir=rig.workdir, config_dir=scratch / "cfg", cli_home=rig.home
            ),
            log=MagicMock(),
            limits=PromptLimits(
                inactivity_timeout_seconds=300,
                prompt_max_duration_seconds=600,
                prompt_cleanup_timeout_seconds=5,
            ),
            environ=rig.environ,
        )
        (rig.workdir / "hello.txt").write_text("hi\n")
        return rig

    async def test_pong_tool_turn_resume_and_large_prompt(self, live: Rig):
        before = _agy_pids()
        await live.harness.open()
        await live.harness.create_session()
        model = {"model": LIVE_MODEL, "reasoning_effort": "low"}

        outcome = await live.harness.run_prompt(
            prompt("Reply with exactly PONG and nothing else.", **model), live.emit
        )
        assert outcome.success, outcome.error
        conversation = live.harness.session_id
        assert conversation
        tokens = [e["content"] for e in live.events if e["type"] == "token"]
        assert tokens and "PONG" in tokens[-1]

        live.events.clear()
        outcome = await live.harness.run_prompt(
            prompt("Run the shell command `ls` and tell me the file names.", **model), live.emit
        )
        assert outcome.success, outcome.error
        calls = [e for e in live.events if e["type"] == "tool_call"]
        assert any(c["tool"] == "bash" and c["status"] == "completed" for c in calls)
        assert "hello.txt" in [e for e in live.events if e["type"] == "token"][-1]["content"]
        assert live.harness.session_id == conversation

        assert await live.harness.resume_session(conversation)
        live.events.clear()
        filler = "Ignore this filler line.\n" * (PROMPT_ARGV_LIMIT_BYTES // 20)
        outcome = await live.harness.run_prompt(
            prompt(filler + "\nReply with exactly STDINPONG.", **model), live.emit
        )
        assert outcome.success, outcome.error
        assert "STDINPONG" in [e for e in live.events if e["type"] == "token"][-1]["content"]
        assert live.harness.session_id == conversation
        assert not [e for e in live.events if e["type"] == "warning"]
        assert _agy_pids() <= before

    async def test_abort_leaves_no_survivors(self, live: Rig):
        before = _agy_pids()
        await live.harness.open()
        task = asyncio.create_task(
            live.harness.run_prompt(
                prompt("Run the shell command `sleep 127`, then reply DONE.", model=LIVE_MODEL),
                live.emit,
            )
        )
        for _ in range(600):
            if any(e["type"] == "tool_call" for e in live.events):
                break
            await asyncio.sleep(0.1)
        assert await live.harness.abort()
        outcome = await task
        assert outcome.cancelled
        await asyncio.sleep(0.5)
        assert _agy_pids() <= before
        leftover = subprocess.run(
            ["pgrep", "-f", "^sleep 127$"], capture_output=True, text=True, check=False
        )
        for pid in leftover.stdout.split():
            os.kill(int(pid), signal.SIGKILL)
        assert leftover.stdout.strip() == ""
