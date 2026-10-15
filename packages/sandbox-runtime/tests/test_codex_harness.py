# ruff: noqa: RUF001  (Codex writes its messages with U+2019 apostrophes)
"""CodexHarness against a fake ``codex`` executable.

The fake replays a recorded ``codex exec --json`` transcript (or a scripted
one) and records the argv, environment and stdin it was started with, so the
tests assert what really reaches the child: CODEX_HOME on the subscription
home, no OpenAI key, the prompt on stdin, and ``resume <thread>`` on a later
turn.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
import sys
import tomllib
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness import AgentHarness, HarnessPrompt, HarnessStartError, PromptLimits
from sandbox_runtime.harness.base import HarnessId, TurnOutcome
from sandbox_runtime.harness.claude_tools import ToolServerConfig
from sandbox_runtime.harness.codex import (
    CodexHarness,
    CodexHarnessConfig,
    bare_openai_model,
    rollout_exists,
)
from sandbox_runtime.harness.codex_env import codex_child_env, codex_home_path
from sandbox_runtime.harness.codex_pool import FailureKind
from sandbox_runtime.harness.codex_tools import (
    read_tool_config,
    tool_server_overrides,
    write_tool_config,
)
from sandbox_runtime.harness.codex_translate import (
    CodexTranslator,
    CodexTurnState,
    parse_event_line,
    usage_tokens,
)

TRANSCRIPT = Path(__file__).parent / "fixtures" / "codex_exec_turn.jsonl"
THREAD_ID = "0199a213-81c0-7800-8aa1-bbab2a035a53"
LIMITS = PromptLimits(
    inactivity_timeout_seconds=5.0,
    prompt_max_duration_seconds=30.0,
    prompt_cleanup_timeout_seconds=2.0,
)

FAKE_CODEX = """#!{python}
import json, os, sys, time
record = os.environ["FAKE_CODEX_RECORD"]
with open(record, "a") as handle:
    handle.write(json.dumps({{
        "argv": sys.argv[1:],
        "env": {{k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}},
        "stdin": sys.stdin.read(),
        "pid": os.getpid(),
    }}) + "\\n")
sys.stderr.write("fake codex starting\\n")
sys.stderr.flush()
with open(os.environ["FAKE_CODEX_TRANSCRIPT"]) as transcript:
    for line in transcript:
        if line.startswith("#sleep "):
            time.sleep(float(line.split()[1]))
            continue
        sys.stdout.write(line)
        sys.stdout.flush()
sys.exit(int(os.environ.get("FAKE_CODEX_EXIT", "0")))
"""


class Rig:
    """A subscription home, a fake codex and a harness wired to both."""

    def __init__(self, tmp_path: Path, *, auth: bool = True, providers: str = "anthropic,openai"):
        self.tmp_path = tmp_path
        self.auth_home = tmp_path / ".sf-auth"
        (self.auth_home / "codex").mkdir(parents=True)
        if auth:
            # Placeholder only: the harness never opens it.
            (self.auth_home / "codex" / "auth.json").write_text('{"placeholder": true}')
        self.binary = tmp_path / "bin" / "codex"
        self.binary.parent.mkdir()
        self.binary.write_text(FAKE_CODEX.format(python=sys.executable))
        self.binary.chmod(self.binary.stat().st_mode | stat.S_IXUSR)
        self.record = tmp_path / "record.jsonl"
        self.transcript = tmp_path / "transcript.jsonl"
        self.transcript.write_text(TRANSCRIPT.read_text())
        self.workdir = tmp_path / "workspace"
        self.workdir.mkdir()
        self.environ = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(tmp_path),
            "SF_AUTH_HOME": str(self.auth_home),
            "SF_AUTH_HOME_PROVIDERS": providers,
            # Placeholders: the child must never see either.
            "OPENAI_API_KEY": "placeholder-openai-key",
            "CODEX_API_KEY": "placeholder-codex-key",
            "FAKE_CODEX_RECORD": str(self.record),
            "FAKE_CODEX_TRANSCRIPT": str(self.transcript),
        }
        self.events: list[dict[str, Any]] = []
        self.harness = self.build()

    def build(self, **config: Any) -> CodexHarness:
        return CodexHarness(
            config=CodexHarnessConfig(
                workdir=self.workdir,
                config_dir=self.tmp_path / "codex-config",
                default_model="openai/gpt-6-sol",
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


def prompt(text: str = "What is in this repository?", **fields: Any) -> HarnessPrompt:
    return HarnessPrompt(message_id="msg-1", text=text, model="openai/gpt-6-sol", **fields)


@pytest.fixture
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


class TestRecordedTurn:
    async def test_conforms_to_the_seam(self, rig: Rig):
        assert isinstance(rig.harness, AgentHarness)
        assert rig.harness.id is HarnessId.CODEX

    async def test_a_recorded_turn_becomes_text_one_tool_call_and_its_result(self, rig: Rig):
        await rig.harness.open()
        await rig.harness.create_session()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        step_id = rig.events[0]["stepId"]
        assert rig.events == [
            {"type": "step_start", "messageId": "msg-1", "stepId": step_id},
            {
                "type": "tool_call",
                "tool": "bash",
                "args": {"command": "bash -lc ls"},
                "callId": "item_1",
                "status": "running",
                "output": "",
                "messageId": "msg-1",
            },
            {
                "type": "tool_call",
                "tool": "bash",
                "args": {"command": "bash -lc ls"},
                "callId": "item_1",
                "status": "completed",
                "output": "README.md\nsrc\n",
                "messageId": "msg-1",
            },
            {
                "type": "token",
                "content": "The repository has a README and a src directory.",
                "messageId": "msg-1",
            },
            {
                "type": "step_finish",
                "messageId": "msg-1",
                "stepId": step_id,
                "reason": "stop",
                "tokens": {"input": 2048, "output": 64, "reasoning": 16, "cache": {"read": 1024}},
            },
        ]
        assert rig.harness.session_id == THREAD_ID

    async def test_the_child_runs_on_the_home_without_any_openai_key(self, rig: Rig):
        await rig.harness.open()
        await rig.harness.run_prompt(prompt(), rig.emit)

        [run] = rig.runs()
        assert run["env"]["CODEX_HOME"] == str(rig.auth_home / "codex")
        assert "OPENAI_API_KEY" not in run["env"]
        assert "CODEX_API_KEY" not in run["env"]
        assert run["stdin"] == "What is in this repository?"
        assert run["argv"][:2] == ["exec", "--json"]
        assert "--ignore-user-config" in run["argv"]
        assert run["argv"][run["argv"].index("--model") + 1] == "gpt-6-sol"
        assert run["argv"][run["argv"].index("--cd") + 1] == str(rig.workdir)
        assert run["argv"][-1] == "-"
        assert "resume" not in run["argv"]

    async def test_the_next_turn_resumes_the_thread(self, rig: Rig):
        await rig.harness.open()
        await rig.harness.run_prompt(prompt(), rig.emit)
        await rig.harness.run_prompt(prompt("And now?"), rig.emit)

        second = rig.runs()[1]["argv"]
        assert second[second.index("resume") : second.index("resume") + 3] == [
            "resume",
            THREAD_ID,
            "-",
        ]

    async def test_reasoning_and_memory_reach_codex_as_config(self, rig: Rig):
        harness = rig.build(developer_instructions='# Memory\n- "be brief"')
        await harness.open()
        await harness.run_prompt(prompt(reasoning_effort="high"), rig.emit)

        argv = rig.runs()[0]["argv"]
        configs = [argv[i + 1] for i, arg in enumerate(argv) if arg == "--config"]
        parsed = [tomllib.loads(config) for config in configs]
        assert {"model_reasoning_effort": "high"} in parsed
        assert {"developer_instructions": '# Memory\n- "be brief"'} in parsed
        assert {"forced_login_method": "chatgpt"} in parsed
        assert {"cli_auth_credentials_store": "file"} in parsed

    async def test_images_are_passed_after_the_prompt_and_removed_afterwards(self, rig: Rig):
        await rig.harness.open()
        attachment = {
            "name": "shot.png",
            "mimeType": "image/png",
            "content": base64.b64encode(b"png-bytes").decode(),
        }
        await rig.harness.run_prompt(prompt(attachments=(attachment,)), rig.emit)

        argv = rig.runs()[0]["argv"]
        image = Path(argv[argv.index("--image") + 1])
        assert argv[argv.index("--image") - 1] == "-"
        assert image.name == "msg-1-0.png"
        assert not image.exists()


class TestCredential:
    async def test_a_missing_auth_json_asks_for_a_relogin(self, tmp_path: Path):
        rig = Rig(tmp_path, auth=False)
        with pytest.raises(HarnessStartError, match="re-login in your auth home"):
            await rig.harness.open()

    async def test_a_logout_between_turns_is_a_start_error_too(self, rig: Rig):
        await rig.harness.open()
        (rig.auth_home / "codex" / "auth.json").unlink()
        with pytest.raises(HarnessStartError, match="re-login in your auth home"):
            await rig.harness.run_prompt(prompt(), rig.emit)

    async def test_no_mounted_home_refuses_to_start(self, rig: Rig):
        del rig.environ["SF_AUTH_HOME"]
        with pytest.raises(HarnessStartError, match="runs only on a subscription home"):
            await rig.harness.open()

    async def test_a_home_without_openai_refuses_to_start(self, tmp_path: Path):
        rig = Rig(tmp_path, providers="anthropic")
        with pytest.raises(HarnessStartError, match="does not carry a Codex login"):
            await rig.harness.open()

    def test_codex_home_is_the_codex_directory_of_the_kubernetes_mount(self):
        home = codex_home_path("/home/sandbox/.sf-auth")
        assert str(home) == "/home/sandbox/.sf-auth/codex"
        env = codex_child_env({"OPENAI_API_KEY": "placeholder", "PATH": "/bin"}, home)
        assert env == {"PATH": "/bin", "CODEX_HOME": "/home/sandbox/.sf-auth/codex"}

    async def test_a_refused_login_fails_the_turn_with_the_relogin_hint(self, rig: Rig):
        rig.transcript.write_text(
            '{"type":"thread.started","thread_id":"' + THREAD_ID + '"}\n'
            '{"type":"turn.started"}\n'
            '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized)"}\n'
            '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}\n'
        )
        rig.environ["FAKE_CODEX_EXIT"] = "1"
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert not outcome.success
        assert "re-login in your auth home" in (outcome.error or "")
        assert {
            "type": "warning",
            "scope": "provider",
            "message": "Reconnecting... 1/5 (unexpected status 401 Unauthorized)",
        } in rig.events


class TestSessions:
    async def test_resume_with_an_unknown_id_returns_false(self, rig: Rig):
        await rig.harness.open()
        assert await rig.harness.resume_session("0199a213-0000-7000-8000-000000000000") is False
        assert rig.harness.session_id is None

    async def test_resume_with_a_non_uuid_returns_false(self, rig: Rig):
        await rig.harness.open()
        assert await rig.harness.resume_session("../../etc/passwd") is False

    async def test_resume_adopts_a_thread_whose_rollout_is_in_the_home(self, rig: Rig):
        rollout = rig.auth_home / "codex" / "sessions" / "2026" / "10" / "09"
        rollout.mkdir(parents=True)
        (rollout / f"rollout-2026-10-09T15-16-49-{THREAD_ID}.jsonl").write_text("{}\n")
        await rig.harness.open()

        assert await rig.harness.resume_session(THREAD_ID) is True
        assert rig.harness.session_id == THREAD_ID
        assert rollout_exists(rig.auth_home / "codex", THREAD_ID)


class TestProcessHandling:
    async def test_an_exit_without_a_terminal_event_fails_with_the_stderr_tail(self, rig: Rig):
        rig.transcript.write_text('{"type":"thread.started","thread_id":"' + THREAD_ID + '"}\n')
        rig.environ["FAKE_CODEX_EXIT"] = "3"
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.failed(
            "Codex exited with code 3 before the turn completed: fake codex starting"
        )

    async def test_silence_past_the_inactivity_budget_fails_and_kills_codex(self, rig: Rig):
        rig.transcript.write_text('{"type":"turn.started"}\n#sleep 30\n')
        harness = CodexHarness(
            config=rig.harness.config,
            log=MagicMock(),
            limits=PromptLimits(
                inactivity_timeout_seconds=0.5,
                prompt_max_duration_seconds=30.0,
                prompt_cleanup_timeout_seconds=2.0,
            ),
            environ=rig.environ,
        )
        await harness.open()

        outcome = await harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.failed("Codex produced no output for 0s.")
        assert not _alive(rig.runs()[0]["pid"])

    async def _started(self, rig: Rig) -> asyncio.Task[TurnOutcome]:
        rig.transcript.write_text('{"type":"turn.started"}\n#sleep 30\n')
        await rig.harness.open()
        task = asyncio.create_task(rig.harness.run_prompt(prompt(), rig.emit))
        while not rig.record.exists() or not rig.events:
            await asyncio.sleep(0.05)
        return task

    async def test_abort_stops_codex_and_settles_the_turn_as_cancelled(self, rig: Rig):
        task = await self._started(rig)

        assert await rig.harness.abort() is True

        assert await task == TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
        assert not _alive(rig.runs()[0]["pid"])
        assert await rig.harness.abort() is False

    async def test_cancelling_the_turn_kills_codex(self, rig: Rig):
        task = await self._started(rig)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not _alive(rig.runs()[0]["pid"])

    async def test_stop_execution_confirms_codex_is_gone(self, rig: Rig):
        task = await self._started(rig)

        assert await rig.harness.stop_execution(2.0) is True
        await task
        assert not _alive(rig.runs()[0]["pid"])

    async def test_a_missing_binary_is_a_start_error(self, rig: Rig):
        harness = rig.build()
        harness.config = CodexHarnessConfig(
            workdir=rig.workdir, config_dir=rig.tmp_path / "cfg", binary=str(rig.tmp_path / "nope")
        )
        await harness.open()
        with pytest.raises(HarnessStartError, match="codex CLI is not installed"):
            await harness.run_prompt(prompt(), rig.emit)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers signal 0; it has exited all the same.
    try:
        with open(f"/proc/{pid}/stat") as handle:
            return handle.read().split()[2] != "Z"
    except OSError:
        return False


class TestModel:
    def test_strips_the_openai_prefix(self):
        assert bare_openai_model("openai/gpt-6-sol") == "gpt-6-sol"
        assert bare_openai_model("gpt-6-luna") == "gpt-6-luna"

    def test_refuses_other_providers(self):
        with pytest.raises(ValueError, match="cannot run provider 'anthropic'"):
            bare_openai_model("anthropic/claude-sonnet-4-6")


class TestTranslator:
    def turn(self, *events: dict[str, Any]) -> tuple[CodexTurnState, list[dict[str, Any]]]:
        translator = CodexTranslator()
        state = CodexTurnState(message_id="m")
        out: list[dict[str, Any]] = []
        for event in events:
            out.extend(translator.translate(state, event).events)
        return state, out

    def test_names_open_inspect_tools_bare_and_other_mcp_tools_qualified(self):
        _, events = self.turn(
            {
                "type": "item.completed",
                "item": {
                    "id": "c1",
                    "type": "mcp_tool_call",
                    "server": "oi",
                    "tool": "memory_search",
                    "arguments": {"query": "deploy"},
                    "result": {"content": [{"type": "text", "text": "2 facts"}]},
                    "status": "completed",
                },
            },
            {
                "type": "item.completed",
                "item": {
                    "id": "c2",
                    "type": "mcp_tool_call",
                    "server": "docs",
                    "tool": "lookup",
                    "arguments": "{}",
                    "error": {"message": "server down"},
                    "status": "failed",
                },
            },
        )
        calls = [event for event in events if event["type"] == "tool_call"]
        assert [(c["tool"], c["status"], c["output"]) for c in calls] == [
            ("memory_search", "completed", "2 facts"),
            ("mcp__docs__lookup", "error", "server down"),
        ]

    def test_a_failed_command_and_a_file_change(self):
        _, events = self.turn(
            {
                "type": "item.completed",
                "item": {
                    "id": "x",
                    "type": "command_execution",
                    "command": "false",
                    "aggregated_output": "",
                    "exit_code": 1,
                    "status": "failed",
                },
            },
            {
                "type": "item.completed",
                "item": {
                    "id": "f",
                    "type": "file_change",
                    "changes": [{"path": "src/a.py", "kind": "update"}],
                    "status": "completed",
                },
            },
        )
        calls = [event for event in events if event["type"] == "tool_call"]
        assert calls[0]["status"] == "error"
        assert (calls[1]["tool"], calls[1]["output"]) == ("apply_patch", "update src/a.py")

    def test_messages_accumulate_into_one_token_stream(self):
        _, events = self.turn(
            {"type": "item.completed", "item": {"id": "a", "type": "agent_message", "text": "One"}},
            {"type": "item.completed", "item": {"id": "b", "type": "agent_message", "text": "Two"}},
        )
        tokens = [event["content"] for event in events if event["type"] == "token"]
        assert tokens == ["One", "One\n\nTwo"]

    def test_non_json_lines_are_skipped(self):
        assert parse_event_line(b"WARNING: proceeding\n") is None
        assert parse_event_line('{"no_type": 1}') is None
        assert parse_event_line('{"type":"turn.started"}') == {"type": "turn.started"}

    def test_a_usage_limit_is_held_and_classified(self):
        translator = CodexTranslator()
        state = CodexTurnState(message_id="m")
        warning = translator.translate(state, {"type": "error", "message": USAGE_TEXT})
        failed = translator.translate(
            state, {"type": "turn.failed", "error": {"message": USAGE_TEXT}}
        )
        assert warning.hold and failed.hold
        assert failed.outcome is not None and not failed.outcome.success
        assert state.failure_kind is FailureKind.USAGE_LIMIT
        assert state.failure_detail == USAGE_TEXT

    def test_other_failures_and_retries_are_not_held(self):
        translator = CodexTranslator()
        state = CodexTurnState(message_id="m")
        retry = translator.translate(state, {"type": "error", "message": "Reconnecting... 1/5"})
        failed = translator.translate(
            state, {"type": "turn.failed", "error": {"message": "stream disconnected"}}
        )
        assert not retry.hold and not failed.hold
        assert state.failure_kind is None

    def test_a_refusal_carries_the_slot_hint(self):
        state = CodexTurnState(message_id="m", relogin_hint="re-enrol codex-2")
        failed = CodexTranslator().translate(
            state, {"type": "turn.failed", "error": {"message": REFUSED_TEXT}}
        )
        assert failed.hold and state.failure_kind is FailureKind.AUTH_REFUSED
        assert failed.outcome is not None and "re-enrol codex-2" in (failed.outcome.error or "")

    def test_progress_starts_with_the_first_item_that_is_not_reasoning(self):
        state, _ = self.turn(
            {"type": "item.completed", "item": {"id": "r", "type": "reasoning", "text": "hm"}}
        )
        assert not state.progress
        state, _ = self.turn(
            {"type": "item.started", "item": {"id": "c", "type": "command_execution"}}
        )
        assert state.progress

    def test_a_retry_keeps_the_step_and_text_but_not_the_item_ids(self):
        translator = CodexTranslator()
        state = CodexTurnState(message_id="m")
        message = {"type": "item.completed", "item": {"id": "item_0", "type": "agent_message"}}
        first = translator.translate(state, {**message, "item": {**message["item"], "text": "A"}})
        step_id = state.step_id
        state.reset_for_retry()
        second = translator.translate(state, {**message, "item": {**message["item"], "text": "B"}})
        assert state.step_id == step_id
        assert [e["content"] for e in first.events if e["type"] == "token"] == ["A"]
        assert [e["content"] for e in second.events if e["type"] == "token"] == ["A\n\nB"]
        assert (state.progress, state.failure_kind, state.held) == (True, None, [])

    def test_usage_without_counts_is_dropped(self):
        assert usage_tokens({}) is None
        assert usage_tokens({"output_tokens": 3}) == {"output": 3}


class TestToolServer:
    def test_the_config_file_is_private_and_round_trips(self, tmp_path: Path):
        config = ToolServerConfig(
            control_plane_url="https://cp.example",
            session_id="sess-1",
            auth_token="placeholder-token",
            repo_manifest_path=tmp_path / "repos.json",
            has_repository=True,
            slack_notify_enabled=False,
        )
        path = write_tool_config(config, tmp_path / "cfg")
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert read_tool_config(path) == config

    def test_registers_the_oi_server_as_valid_toml(self, tmp_path: Path):
        overrides = [
            tomllib.loads(o) for o in tool_server_overrides(tmp_path / "oi.json", "/usr/bin/py")
        ]
        server = {}
        for override in overrides:
            server.update(override["mcp_servers"]["oi"])
        assert server["command"] == "/usr/bin/py"
        assert server["args"] == [
            "-m",
            "sandbox_runtime.harness.codex_tools",
            str(tmp_path / "oi.json"),
        ]
        assert Path(server["env"]["PYTHONPATH"], "sandbox_runtime", "harness").is_dir()


# --- the login pool (harness/codex_pool.py) ----------------------------------

FAILED_THREAD = "0199a213-0000-7000-8000-00000000fa11"
USAGE_TEXT = (
    "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase "
    "more credits or try again at Oct 20th, 2026 5:11 AM."
)
REFUSED_TEXT = (
    "Your access token could not be refreshed because your refresh token was already used. "
    "Please log out and sign in again."
)

# Behaves as the slot's login says: the fake auth.json names a mode, never a token.
FAKE_POOL_CODEX = """#!{python}
import json, os, sys, time
home = os.environ["CODEX_HOME"]
try:
    with open(os.path.join(home, "auth.json")) as handle:
        auth = json.load(handle)
except (OSError, ValueError):
    auth = {{}}
mode, slot = auth.get("mode", "ok"), auth.get("slot")
argv = sys.argv[1:]
resume = argv[argv.index("resume") + 1] if "resume" in argv else None
with open(os.environ["FAKE_CODEX_RECORD"], "a") as handle:
    handle.write(json.dumps({{
        "argv": argv,
        "env": {{k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}},
        "stdin": sys.stdin.read(),
        "slot": slot,
        "mode": mode,
        "pid": os.getpid(),
    }}) + "\\n")

def out(event):
    sys.stdout.write(json.dumps(event) + "\\n")
    sys.stdout.flush()

def fail(text):
    out({{"type": "error", "message": text}})
    out({{"type": "turn.failed", "error": {{"message": text}}}})
    sys.exit(1)

if mode == "stderr_usage":
    sys.stderr.write({usage!r} + "\\n")
    sys.exit(1)
if mode == "foreign" and resume:
    out({{"type": "thread.started", "thread_id": resume}})
    out({{"type": "turn.started"}})
    fail("invalid_encrypted_content: The encrypted content could not be verified.")
ok = mode in ("ok", "foreign", "slow")
out({{"type": "thread.started", "thread_id": resume or ({thread!r} if ok else {failed!r})}})
out({{"type": "turn.started"}})
out({{"type": "item.completed", "item": {{"id": "item_0", "type": "reasoning", "text": "thinking"}}}})
if mode == "slow":
    time.sleep(30)
if mode == "exhausted_slow":
    time.sleep(1.0)
    fail({usage!r})
if mode == "exhausted":
    fail({usage!r})
if mode == "refused":
    fail({refused!r})
if mode == "exhaust_after_tool":
    command = {{"id": "item_1", "type": "command_execution", "command": "touch a", "exit_code": 0,
               "aggregated_output": "", "status": "completed"}}
    out({{"type": "item.started", "item": dict(command, status="in_progress")}})
    out({{"type": "item.completed", "item": command}})
    fail({usage!r})
out({{"type": "item.completed", "item": {{"id": "item_1", "type": "agent_message", "text": "done on " + str(slot)}}}})
out({{"type": "turn.completed", "usage": {{"input_tokens": 10, "output_tokens": 2}}}})
"""


class PoolRig(Rig):
    """A home whose Codex logins are pool slots, each with a scripted behaviour."""

    def __init__(
        self, tmp_path: Path, modes: dict[str, str], *, percents: dict[str, int] | None = None
    ):
        super().__init__(tmp_path, auth=False)
        self.pool = self.auth_home / "codex-pool"
        self.pool.mkdir()
        for slot, mode in modes.items():
            (self.pool / slot).mkdir(parents=True)
            self.set_mode(slot, mode)
        # Fresh headroom that ranks the slots in the order given: 100, 80, 60, ...
        percents = percents or {slot: 100 - 20 * i for i, slot in enumerate(modes)}
        self.headroom(percents)
        self.binary.write_text(
            FAKE_POOL_CODEX.format(
                python=sys.executable,
                usage=USAGE_TEXT,
                refused=REFUSED_TEXT,
                thread=THREAD_ID,
                failed=FAILED_THREAD,
            )
        )
        self.environ["CODEX_ACCESS_TOKEN"] = "placeholder-access-token"
        self.environ["CODEX_REFRESH_TOKEN_URL_OVERRIDE"] = "https://example.invalid/token"
        self.harness = self.build()

    def set_mode(self, slot: str, mode: str) -> None:
        (self.pool / slot / "auth.json").write_text(json.dumps({"slot": slot, "mode": mode}))

    def headroom(self, percents: dict[str, int]) -> None:
        from datetime import UTC, datetime

        (self.pool / "headroom.json").write_text(
            json.dumps(
                {
                    "capturedAt": datetime.now(UTC).isoformat(),
                    "slots": {
                        slot: {"windows": [{"id": "weekly", "percentRemaining": pct}]}
                        for slot, pct in percents.items()
                    },
                }
            )
        )

    def link(self) -> str:
        return str((self.auth_home / "codex" / "auth.json").readlink())

    def state(self) -> dict[str, Any]:
        return json.loads((self.pool / "state.json").read_text())

    def warnings(self) -> list[str]:
        return [e["message"] for e in self.events if e["type"] == "warning"]

    def errors(self) -> list[str]:
        return [e["error"] for e in self.events if e["type"] == "error"]


THREE = {"codex-1": "ok", "codex-2": "ok", "codex-3": "ok"}


def _configs(argv: list[str]) -> list[dict[str, Any]]:
    return [tomllib.loads(argv[i + 1]) for i, arg in enumerate(argv) if arg == "--config"]


class TestPoolTurn:
    async def test_a_turn_runs_on_the_ranked_slot_through_the_link(self, tmp_path: Path):
        rig = PoolRig(tmp_path, THREE)
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        [run] = rig.runs()
        assert run["slot"] == "codex-1"
        assert run["env"]["CODEX_HOME"] == str(rig.auth_home / "codex")
        assert rig.link() == "../codex-pool/codex-1/auth.json"
        assert rig.harness.subscription_slot == "codex-1"
        record = json.loads((rig.tmp_path / "codex-config" / "sf-codex-pool-pick.json").read_text())
        assert {k: record[k] for k in ("slot", "reason", "percentRemaining", "attempt")} == {
            "slot": "codex-1",
            "reason": "ranked",
            "percentRemaining": 100,
            "attempt": 0,
        }
        assert rig.state()["threads"] == {THREAD_ID: "codex-1"}

    async def test_pool_mode_strips_the_token_env_and_hides_codex_home_from_tools(
        self, tmp_path: Path
    ):
        rig = PoolRig(tmp_path, THREE)
        await rig.harness.open()
        await rig.harness.run_prompt(prompt(), rig.emit)

        [run] = rig.runs()
        for name in (
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
        ):
            assert name not in run["env"]
        assert {"shell_environment_policy": {"exclude": ["CODEX_HOME"]}} in _configs(run["argv"])

    async def test_a_legacy_login_file_keeps_todays_path(self, tmp_path: Path):
        rig = PoolRig(tmp_path, THREE)
        (rig.auth_home / "codex" / "auth.json").write_text('{"mode": "ok", "slot": "legacy"}')
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        [run] = rig.runs()
        assert run["slot"] == "legacy"
        assert (rig.auth_home / "codex" / "auth.json").is_file()
        assert not (rig.auth_home / "codex" / "auth.json").is_symlink()
        assert rig.harness.subscription_slot is None
        assert not [c for c in _configs(run["argv"]) if "shell_environment_policy" in c]
        assert not (rig.pool / "state.json").exists()
        rig.harness.log.warn.assert_any_call(
            "codex.pool.legacy_file", link="legacy_file", pool_slots=3
        )

    async def test_an_empty_pool_without_a_login_names_the_pool(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {})
        with pytest.raises(HarnessStartError, match="codex-pool/ directory but no slot"):
            await rig.harness.open()


class TestPoolFailover:
    async def test_a_usage_limit_before_any_output_moves_the_turn_to_the_next_slot(
        self, tmp_path: Path
    ):
        rig = PoolRig(tmp_path, {"codex-1": "exhausted", "codex-2": "ok", "codex-3": "ok"})
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        first, second = rig.runs()
        assert (first["slot"], second["slot"]) == ("codex-1", "codex-2")
        # The failed attempt's new thread is dropped: the retry starts fresh with the prompt.
        assert "resume" not in second["argv"]
        assert second["stdin"] == "What is in this repository?"
        assert rig.warnings() == ["Codex slot codex-1 hit its usage limit; continued on codex-2."]
        assert rig.errors() == []
        assert [e["type"] for e in rig.events].count("step_start") == 1
        assert rig.harness.session_id == THREAD_ID
        assert rig.harness.subscription_slot == "codex-2"
        state = rig.state()
        assert state["slots"]["codex-1"]["exhaustedUntil"] == "2026-10-20T05:11:00Z"
        assert state["threads"] == {THREAD_ID: "codex-2"}
        assert rig.link() == "../codex-pool/codex-2/auth.json"

    async def test_a_resumed_thread_resumes_on_the_next_slot(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "exhausted", "codex-2": "ok"})
        _rollout(rig, THREAD_ID)
        await rig.harness.open()
        assert await rig.harness.resume_session(THREAD_ID)

        outcome = await rig.harness.run_prompt(prompt("Next"), rig.emit)

        assert outcome == TurnOutcome.ok()
        first, second = rig.runs()
        for run in (first, second):
            assert run["argv"][run["argv"].index("resume") + 1] == THREAD_ID
            assert run["stdin"] == "Next"
        assert second["slot"] == "codex-2"

    async def test_a_usage_limit_after_output_continues_instead_of_replaying(self, tmp_path: Path):
        from sandbox_runtime.harness.codex_pool import CONTINUE_PROMPT

        rig = PoolRig(tmp_path, {"codex-1": "exhaust_after_tool", "codex-2": "ok"})
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        _, second = rig.runs()
        assert second["argv"][second["argv"].index("resume") + 1] == FAILED_THREAD
        assert second["stdin"] == CONTINUE_PROMPT
        calls = [e for e in rig.events if e["type"] == "tool_call"]
        assert [c["status"] for c in calls] == ["running", "completed"]
        tokens = [e["content"] for e in rig.events if e["type"] == "token"]
        assert tokens == ["done on codex-2"]
        assert len({e["stepId"] for e in rig.events if "stepId" in e}) == 1

    async def test_codex_exiting_with_the_limit_on_stderr_fails_over_too(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "stderr_usage", "codex-2": "ok"})
        await rig.harness.open()

        assert await rig.harness.run_prompt(prompt(), rig.emit) == TurnOutcome.ok()
        assert [run["slot"] for run in rig.runs()] == ["codex-1", "codex-2"]

    async def test_every_slot_exhausted_ends_with_one_error_naming_the_reset(self, tmp_path: Path):
        rig = PoolRig(tmp_path, dict.fromkeys(THREE, "exhausted"))
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert not outcome.success
        assert outcome.error is not None
        assert outcome.error.startswith(
            "Codex turn failed: every Codex subscription slot is at its limit "
            "(earliest reset 2026-10-20T05:11:00Z): You’ve hit your usage limit."
        )
        assert rig.errors() == [outcome.error]
        assert [run["slot"] for run in rig.runs()] == ["codex-1", "codex-2", "codex-3"]
        # The limit's own warnings stay held back; only the failovers are announced.
        assert rig.warnings() == ["Codex slot codex-1 hit its usage limit; continued on codex-2."]

    async def test_the_next_turn_skips_the_exhausted_slot(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "exhausted", "codex-2": "ok"})
        await rig.harness.open()
        await rig.harness.run_prompt(prompt(), rig.emit)
        rig.set_mode("codex-1", "ok")

        await rig.harness.run_prompt(prompt("Again"), rig.emit)

        assert [run["slot"] for run in rig.runs()] == ["codex-1", "codex-2", "codex-2"]

    async def test_a_refused_login_is_marked_named_and_skipped(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "refused", "codex-2": "ok"})
        await rig.harness.open()

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.ok()
        [refusal, failover] = rig.warnings()
        assert "slot codex-1 was refused" in refusal
        assert "--codex-slot codex-1" in refusal
        assert failover == "Codex slot codex-1 was refused by OpenAI; continued on codex-2."
        assert "authRefused" in rig.state()["slots"]["codex-1"]

    async def test_a_thread_another_account_made_is_rebased_once(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "foreign", "codex-2": "ok"})
        _rollout(rig, THREAD_ID, "Write the parser")
        await rig.harness.open()
        assert await rig.harness.resume_session(THREAD_ID)

        outcome = await rig.harness.run_prompt(prompt("Now the tests"), rig.emit)

        assert outcome == TurnOutcome.ok()
        first, second = rig.runs()
        assert first["slot"] == second["slot"] == "codex-1"
        assert "resume" in first["argv"]
        assert "resume" not in second["argv"]
        assert "user: Write the parser" in second["stdin"]
        assert second["stdin"].endswith("Now the tests")
        assert any("continues in a new thread" in w for w in rig.warnings())
        assert rig.errors() == []
        rig.harness.log.warn.assert_any_call(
            "codex.pool.rebase", slot="codex-1", agent_session_id=THREAD_ID
        )

    async def test_an_abort_between_attempts_cancels_the_turn(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "exhausted", "codex-2": "ok"})
        await rig.harness.open()

        async def emit(event: dict[str, Any]) -> None:
            rig.events.append(event)
            if event["type"] == "warning":
                assert await rig.harness.abort() is True

        outcome = await rig.harness.run_prompt(prompt(), emit)

        assert outcome == TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
        assert len(rig.runs()) == 1
        assert await rig.harness.abort() is False

    async def test_the_deadline_is_shared_by_every_attempt(self, tmp_path: Path):
        rig = PoolRig(tmp_path, {"codex-1": "exhausted_slow", "codex-2": "slow"})
        harness = CodexHarness(
            config=rig.harness.config,
            log=MagicMock(),
            limits=PromptLimits(
                inactivity_timeout_seconds=10.0,
                prompt_max_duration_seconds=2.0,
                prompt_cleanup_timeout_seconds=2.0,
            ),
            environ=rig.environ,
        )
        await harness.open()
        started = asyncio.get_running_loop().time()

        outcome = await harness.run_prompt(prompt(), rig.emit)

        assert outcome == TurnOutcome.failed("Prompt exceeded max duration of 2s.")
        assert asyncio.get_running_loop().time() - started < 5
        assert [run["slot"] for run in rig.runs()] == ["codex-1", "codex-2"]
        assert not _alive(rig.runs()[1]["pid"])

    async def test_a_child_not_confirmed_gone_pins_the_link(self, tmp_path: Path):
        """W3: once a child may outlive its turn, the link never moves again."""
        rig = PoolRig(tmp_path, {"codex-1": "exhausted", "codex-2": "ok"})
        await rig.harness.open()
        rig.harness._pool_dirty = True
        (rig.auth_home / "codex" / "auth.json").symlink_to("../codex-pool/codex-1/auth.json")

        outcome = await rig.harness.run_prompt(prompt(), rig.emit)

        assert not outcome.success
        assert "hit your usage limit" in (outcome.error or "")
        assert [run["slot"] for run in rig.runs()] == ["codex-1"]
        assert rig.link() == "../codex-pool/codex-1/auth.json"
        # The held failure is released as it would be without a pool.
        assert rig.errors() == [outcome.error]
        assert USAGE_TEXT in rig.warnings()


def _rollout(rig: Rig, thread_id: str, text: str = "Earlier request") -> Path:
    directory = rig.auth_home / "codex" / "sessions" / "2026" / "10" / "14"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"rollout-2026-10-14T09-00-00-{thread_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            }
        )
        + "\n"
    )
    return path
