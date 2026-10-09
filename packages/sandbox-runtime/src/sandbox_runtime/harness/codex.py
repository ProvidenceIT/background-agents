"""Bridge half of the Codex harness: one ``codex exec --json`` child per turn.

ChatGPT reaches a session only through the Codex CLI reading the
``auth.json`` of the subscription home the control plane mounted (there is
no OpenAI key anywhere). Each turn runs

    codex exec --json [options] [resume <thread id>] -

with the prompt on stdin, ``CODEX_HOME`` on the home's ``codex/`` directory
and the OpenAI key family stripped from the child's environment. Codex reads
and refreshes the login itself; the harness only checks the file is present.
The control plane serializes Codex sessions per home with a fenced lease, so
no two sandboxes refresh the same login at once.

Codex prints its events as JSON lines; ``CodexTranslator`` turns them into
bridge events. The conversation id is the ``thread_id`` of
``thread.started``; the bridge persists it after each turn, and a later turn
(or a restored sandbox) resumes it with ``codex exec resume`` as long as the
thread's rollout is still in the home's ``sessions/`` tree.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import contextlib
import json
import os
import signal
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Final

from .base import (
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .codex_env import AUTH_HOME_CODEX_AUTH_MISSING, codex_child_env, codex_home
from .codex_tools import tool_server_overrides, write_tool_config
from .codex_translate import CodexTranslator, CodexTurnState, parse_event_line

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

    from ..log_config import StructuredLogger
    from .claude_tools import ToolServerConfig

CODEX_BINARY: Final = "codex"
DEFAULT_CODEX_MODEL: Final = "gpt-6-sol"
# One JSON line can carry a command's whole output.
STDOUT_LINE_LIMIT_BYTES: Final = 16 * 1024 * 1024
STDERR_TAIL_LINES: Final = 20
ATTACHMENTS_DIR_NAME: Final = "attachments"
_IMAGE_SUFFIXES: Final = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
# Fixed for every session: Codex must never prompt, must read the login from
# the home's file (not a keyring), and must never fall back to an API key.
BASE_CONFIG_OVERRIDES: Final = (
    "check_for_update_on_startup=false",
    'cli_auth_credentials_store="file"',
    'forced_login_method="chatgpt"',
)


class _InactivityTimeout(Exception):
    """Codex printed nothing for longer than the inactivity budget."""


def bare_openai_model(model: str | None, default: str = DEFAULT_CODEX_MODEL) -> str:
    """``openai/gpt-x`` → ``gpt-x``; a bare id passes through."""
    value = model or default
    if "/" in value:
        provider, _, bare = value.partition("/")
        if provider != "openai":
            raise ValueError(f"The Codex harness cannot run provider {provider!r}")
        return bare
    return value


def rollout_exists(home: Path, thread_id: str) -> bool:
    """Whether the home still holds the thread's rollout (``sessions/Y/M/D/rollout-*-<id>.jsonl``)."""
    try:
        uuid.UUID(thread_id)
    except ValueError:
        return False
    return any(
        path.is_file() for path in (home / "sessions").glob(f"*/*/*/rollout-*-{thread_id}.jsonl")
    )


@dataclass(frozen=True)
class CodexHarnessConfig:
    workdir: Path
    # Per-sandbox harness directory (never CODEX_HOME): tool config, attachments.
    config_dir: Path
    default_model: str = DEFAULT_CODEX_MODEL
    developer_instructions: str | None = None
    tools: ToolServerConfig | None = None
    binary: str = CODEX_BINARY
    extra_overrides: tuple[str, ...] = field(default_factory=tuple)


class CodexHarness:
    """``AgentHarness`` over the Codex CLI."""

    id = HarnessId.CODEX

    def __init__(
        self,
        config: CodexHarnessConfig,
        log: StructuredLogger,
        limits: PromptLimits,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.limits = limits
        self.environ: Mapping[str, str] = os.environ if environ is None else environ
        self.session_id: str | None = None
        self.codex_home: Path | None = None
        self._tool_config_path: Path | None = None
        self._translator = CodexTranslator()
        self._process: asyncio.subprocess.Process | None = None
        self._aborted = False

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Find the home's Codex login; a missing home or file is a start error."""
        self.codex_home = codex_home(self.environ)
        if self.config.tools is not None:
            self._tool_config_path = write_tool_config(self.config.tools, self.config.config_dir)
        self.log.info(
            "codex.open",
            codex_home=str(self.codex_home),
            workdir=str(self.config.workdir),
            tools=self._tool_config_path is not None,
        )

    async def close(self) -> None:
        await self._terminate(self.limits.prompt_cleanup_timeout_seconds)

    async def resume_session(self, persisted_id: str) -> bool:
        if self.codex_home is None or not rollout_exists(self.codex_home, persisted_id):
            self.log.info("codex.session.invalid", agent_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        self.log.info("codex.session.ensure", agent_session_id=persisted_id, action="loaded")
        return True

    async def create_session(self) -> None:
        # Codex names the thread itself; the first turn's thread.started sets the id.
        self.session_id = None
        self.log.info("codex.session.ensure", action="deferred_to_first_turn")

    # --- turns ---------------------------------------------------------------

    def build_argv(self, model: str, reasoning_effort: str | None, images: list[Path]) -> list[str]:
        overrides = [*BASE_CONFIG_OVERRIDES, *self.config.extra_overrides]
        if reasoning_effort:
            overrides.append(f"model_reasoning_effort={json.dumps(reasoning_effort)}")
        if self.config.developer_instructions:
            overrides.append(
                f"developer_instructions={json.dumps(self.config.developer_instructions)}"
            )
        if self._tool_config_path is not None:
            overrides.extend(tool_server_overrides(self._tool_config_path))
        argv = [
            self.config.binary,
            "exec",
            "--json",
            # The owner's config.toml in the home must not shape other sessions.
            "--ignore-user-config",
            "--skip-git-repo-check",
            # The sandbox pod is the sandbox; Codex's own one cannot nest in it.
            "--dangerously-bypass-approvals-and-sandbox",
            "--cd",
            str(self.config.workdir),
            "--model",
            model,
        ]
        for override in overrides:
            argv.extend(["--config", override])
        if self.session_id:
            argv.extend(["resume", self.session_id])
        # The prompt arrives on stdin; images go last, after every positional.
        argv.append("-")
        if images:
            argv.extend(["--image", *(str(path) for path in images)])
        return argv

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        home = self.codex_home
        if home is None:
            raise HarnessStartError("The Codex harness was not opened.")
        # The owner can log out between turns; that needs the owner, not a retry.
        if not (home / "auth.json").is_file():
            raise HarnessStartError(AUTH_HOME_CODEX_AUTH_MISSING)
        try:
            model = bare_openai_model(prompt.model, self.config.default_model)
        except ValueError as error:
            return TurnOutcome.failed(str(error))
        max_duration = (
            self.limits.prompt_max_duration_seconds
            if prompt.max_duration_seconds is None
            else prompt.max_duration_seconds
        )
        deadline = asyncio.get_running_loop().time() + max_duration
        images = self._write_attachments(prompt)
        stderr_tail: collections.deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        stderr_task: asyncio.Task[None] | None = None
        state = CodexTurnState(message_id=prompt.message_id)
        argv = self.build_argv(model, prompt.reasoning_effort, images)
        self._aborted = False
        self.log.info(
            "codex.turn.start",
            message_id=prompt.message_id,
            model=model,
            resume=self.session_id is not None,
            image_count=len(images),
        )
        try:
            async with asyncio.timeout_at(deadline):
                try:
                    process = await asyncio.create_subprocess_exec(
                        *argv,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        env=codex_child_env(self.environ, home),
                        cwd=str(self.config.workdir),
                        start_new_session=True,
                        limit=STDOUT_LINE_LIMIT_BYTES,
                    )
                except FileNotFoundError as error:
                    raise HarnessStartError(
                        "The codex CLI is not installed in this sandbox image."
                    ) from error
                self._process = process
                stderr_task = asyncio.create_task(self._drain_stderr(process, stderr_tail))
                assert process.stdin is not None and process.stdout is not None
                process.stdin.write(prompt.text.encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
                outcome = await self._read_turn(process, state, emit)
                returncode = await self._reap(process)
            if outcome is not None:
                self.log.info(
                    "codex.turn.finish",
                    message_id=prompt.message_id,
                    success=outcome.success,
                    exit_code=returncode,
                )
                return outcome
            if self._aborted:
                return TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
            detail = " / ".join(stderr_tail) or "no output"
            return TurnOutcome.failed(
                f"Codex exited with code {returncode} before the turn completed: {detail}"
            )
        except asyncio.CancelledError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            raise
        except TimeoutError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            return TurnOutcome.failed(f"Prompt exceeded max duration of {max_duration:.0f}s.")
        except _InactivityTimeout:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            timeout_seconds = self.limits.inactivity_timeout_seconds
            self.log.error("codex.inactivity_timeout", timeout_s=timeout_seconds)
            return TurnOutcome.failed(f"Codex produced no output for {timeout_seconds:.0f}s.")
        finally:
            self._process = None
            if stderr_task is not None:
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stderr_task
            for path in images:
                with contextlib.suppress(OSError):
                    path.unlink()

    async def _read_turn(
        self, process: asyncio.subprocess.Process, state: CodexTurnState, emit: EventSink
    ) -> TurnOutcome | None:
        assert process.stdout is not None
        while True:
            try:
                async with asyncio.timeout(self.limits.inactivity_timeout_seconds):
                    line = await process.stdout.readline()
            except TimeoutError as error:
                raise _InactivityTimeout from error
            if not line:
                return None
            event = parse_event_line(line)
            if event is None:
                continue
            translation = self._translator.translate(state, event)
            if state.thread_id and state.thread_id != self.session_id:
                self.session_id = state.thread_id
                self.log.info(
                    "codex.session.ensure", agent_session_id=state.thread_id, action="created"
                )
            for bridge_event in translation.events:
                await emit(bridge_event)
            if translation.outcome is not None:
                return translation.outcome

    async def _reap(self, process: asyncio.subprocess.Process) -> int | None:
        """Wait for the child after its terminal event; stop it if it lingers."""
        try:
            async with asyncio.timeout(self.limits.prompt_cleanup_timeout_seconds):
                return await process.wait()
        except TimeoutError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            return process.returncode

    async def _drain_stderr(
        self, process: asyncio.subprocess.Process, tail: collections.deque[str]
    ) -> None:
        if process.stderr is None:
            return
        while line := await process.stderr.readline():
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                tail.append(text[:500])
                self.log.debug("codex.stderr", line=text[:500])

    def _write_attachments(self, prompt: HarnessPrompt) -> list[Path]:
        if not prompt.attachments:
            return []
        directory = self.config.config_dir / ATTACHMENTS_DIR_NAME
        directory.mkdir(parents=True, exist_ok=True)
        paths: list[Path] = []
        for index, attachment in enumerate(prompt.attachments):
            suffix = _IMAGE_SUFFIXES.get(str(attachment["mimeType"]), ".img")
            path = directory / f"{prompt.message_id}-{index}{suffix}"
            path.write_bytes(base64.b64decode(attachment["content"]))
            paths.append(path)
        return paths

    # --- stopping ------------------------------------------------------------

    async def abort(self) -> bool:
        if self._process is None or self._process.returncode is not None:
            return False
        self._aborted = True
        await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
        return True

    async def stop_execution(self, timeout_seconds: float) -> bool:
        return await self._terminate(timeout_seconds)

    async def _terminate(self, timeout_seconds: float) -> bool:
        """Stop the child's whole process group: SIGTERM, then SIGKILL. True once it is gone."""
        process = self._process
        if process is None or process.returncode is not None:
            return True
        for sig, share in ((signal.SIGTERM, 0.5), (signal.SIGKILL, 0.5)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                return True
            try:
                async with asyncio.timeout(max(timeout_seconds * share, 0.1)):
                    await process.wait()
                return True
            except TimeoutError:
                self.log.warn("codex.terminate_timeout", signal=sig.name)
        return process.returncode is not None
