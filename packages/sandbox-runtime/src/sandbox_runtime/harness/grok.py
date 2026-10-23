"""Bridge half of the SuperGrok harness: one ``grok -p`` child per turn.

SuperGrok reaches a session only as the access token the owner's machine
pushes into the subscription home (``grok_env``, ``pushed_token``); the
child gets it from ``grok_auth`` through ``GROK_AUTH_PROVIDER_COMMAND`` and
keeps its state in a pod-local ``GROK_HOME``. Each turn runs

    grok --single=<prompt> --output-format streaming-json --always-approve
         --no-auto-update --cwd=<workdir> --model=<model>
         [--reasoning-effort=<e>] [--rules=<memory>] (-s <new id> | -r <id>)

in its own process group (``cli_process``). Free text is bound to its flag
in one argv element: grok reads a separate value that starts with ``-``
(a markdown bullet) as a flag. A prompt too long for a single argv string
goes through a 0600 ``--prompt-file`` instead.

The harness names the conversation itself: ``create_session`` picks a UUID,
so the bridge persists it before the first turn ends, and that turn starts
it with ``-s``. A turn whose session is already in ``$GROK_HOME/sessions``
resumes it with ``-r``. Should grok still fail to restore it, the turn runs
once more on a fresh session, with a warning that the context is gone.

``GrokTranslator`` turns grok's events into bridge events.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import contextlib
import os
import uuid
from typing import TYPE_CHECKING, Final

from .base import (
    ANTHROPIC_MODEL_REFUSAL,
    NO_MODEL_SELECTED,
    EventSink,
    GrokHarnessConfig,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .cli_process import (
    STDERR_TAIL_LINES,
    InactivityTimeout,
    LineTooLong,
    group_alive,
    read_lines_with_inactivity,
    read_stderr_tail,
    reap_group,
    spawn_group,
    terminate_group,
)
from .grok_env import build_child_env, preflight, require_enrolled_home, write_config
from .grok_translate import (
    FailureKind,
    GrokTranslator,
    GrokTurnState,
    failure_outcome,
    parse_event_line,
)

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

    from ..log_config import StructuredLogger

GROK_PROVIDER: Final = "xai"
# Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN); longer prompts go through a file.
PROMPT_ARGV_LIMIT_BYTES: Final = 100 * 1024
PROMPTS_DIR_NAME: Final = "prompts"
ATTACHMENTS_DIR_NAME: Final = "attachments"
# How long a reaped child's stderr reader may take to reach the end of the pipe.
STDERR_SETTLE_SECONDS: Final = 1.0
SESSION_LOST_WARNING: Final = (
    "SuperGrok session lost; starting fresh (earlier context of this conversation is not "
    "available to SuperGrok)."
)
_IMAGE_SUFFIXES: Final = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def bare_grok_model(model: str | None, default: str) -> str:
    """``xai/grok-x`` → ``grok-x``; ``ValueError`` (the user-facing text) for anything else.

    A bare ``grok-*`` id passes through. Any other bare id is an Anthropic one,
    as the control plane reads it, and Anthropic runs only on Claude Agent.
    """
    value = model or default
    if not value:
        raise ValueError(NO_MODEL_SELECTED)
    provider, separator, bare = value.partition("/")
    if not separator:
        if value.startswith("grok-"):
            return value
        raise ValueError(ANTHROPIC_MODEL_REFUSAL)
    if provider == "anthropic":
        raise ValueError(ANTHROPIC_MODEL_REFUSAL)
    if provider != GROK_PROVIDER or not bare:
        raise ValueError(f"The SuperGrok harness cannot run provider {provider!r}")
    return bare


def session_dir(grok_home: Path, session_id: str) -> Path | None:
    """grok's directory for ``session_id`` (``sessions/<encoded cwd>/<id>``), or ``None``."""
    try:
        uuid.UUID(session_id)
    except ValueError:
        return None
    for path in sorted((grok_home / "sessions").glob(f"*/{session_id}")):
        if path.is_dir():
            return path
    return None


class GrokHarness:
    """``AgentHarness`` over the grok CLI."""

    id = HarnessId.GROK

    def __init__(
        self,
        config: GrokHarnessConfig,
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
        self._translator = GrokTranslator()
        self._process: asyncio.subprocess.Process | None = None
        self._aborted = False
        self._account_tag: str | None = None

    @property
    def subscription_slot(self) -> str | None:
        """``grok:<account tag>`` of the pushed token the last turn ran on."""
        return f"grok:{self._account_tag}" if self._account_tag else None

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Check the home is enrolled and stage ``GROK_HOME``; the token is checked per turn."""
        require_enrolled_home(self.environ)
        write_config(self.config.cli_home, self.config.tool_config_path)
        self.log.info(
            "grok.open",
            grok_home=str(self.config.cli_home),
            workdir=str(self.config.workdir),
            tools=self.config.tool_config_path is not None,
        )

    async def close(self) -> None:
        await self._terminate(self.limits.prompt_cleanup_timeout_seconds)

    async def resume_session(self, persisted_id: str) -> bool:
        # grok looks a missing id up remotely and fails; only a local one is resumable.
        if session_dir(self.config.cli_home, persisted_id) is None:
            self.log.info("grok.session.invalid", agent_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        self.log.info("grok.session.ensure", agent_session_id=persisted_id, action="loaded")
        return True

    async def create_session(self) -> None:
        self.session_id = str(uuid.uuid4())
        self.log.info("grok.session.ensure", agent_session_id=self.session_id, action="created")

    # --- turns ---------------------------------------------------------------

    def build_argv(
        self,
        model: str,
        reasoning_effort: str | None,
        *,
        prompt_text: str | None,
        prompt_file: Path | None,
    ) -> list[str]:
        # Values that come from users ride in ``--flag=value``: grok's parser reads a
        # separate argv element that starts with ``-`` ("- fix the bug") as a flag.
        argv = [self.config.binary]
        if prompt_file is not None:
            argv.append(f"--prompt-file={prompt_file}")
        else:
            assert prompt_text is not None
            argv.append(f"--single={prompt_text}")
        argv.extend(
            [
                "--output-format",
                "streaming-json",
                # The pod is the sandbox; a pod GROK_HOME carries no approval preference.
                "--always-approve",
                "--no-auto-update",
                f"--cwd={self.config.workdir}",
                f"--model={model}",
            ]
        )
        if reasoning_effort:
            argv.append(f"--reasoning-effort={reasoning_effort}")
        if self.config.memory_text:
            argv.append(f"--rules={self.config.memory_text}")
        assert self.session_id is not None
        if session_dir(self.config.cli_home, self.session_id) is not None:
            argv.extend(["-r", self.session_id])
        else:
            argv.extend(["-s", self.session_id])
        return argv

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        try:
            model = bare_grok_model(prompt.model, self.config.default_model)
        except ValueError as error:
            return TurnOutcome.failed(str(error))
        # The push can stop between turns; that fails the turn, not the session.
        try:
            token = preflight(self.environ)
        except HarnessStartError as error:
            message = str(error)
            await emit({"type": "error", "error": message, "messageId": prompt.message_id})
            return TurnOutcome.failed(message)
        self._account_tag = token.account_tag
        if self.session_id is None:
            await self.create_session()
        max_duration = (
            self.limits.prompt_max_duration_seconds
            if prompt.max_duration_seconds is None
            else prompt.max_duration_seconds
        )
        deadline = asyncio.get_running_loop().time() + max_duration
        images = self._write_attachments(prompt)
        text = _with_attachments(prompt.text, images)
        prompt_file = self._write_prompt_file(prompt.message_id, text)
        self._aborted = False
        self.log.info(
            "grok.turn.start",
            message_id=prompt.message_id,
            model=model,
            resume=session_dir(self.config.cli_home, self.session_id or "") is not None,
            prompt_file=prompt_file is not None,
            image_count=len(images),
        )
        try:
            async with asyncio.timeout_at(deadline):
                return await self._run_turn(prompt, model, text, prompt_file, emit)
        except asyncio.CancelledError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            raise
        except TimeoutError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            return TurnOutcome.failed(f"Prompt exceeded max duration of {max_duration:.0f}s.")
        except InactivityTimeout as error:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            self.log.error("grok.inactivity_timeout", timeout_s=error.seconds)
            return TurnOutcome.failed(f"SuperGrok produced no output for {error.seconds:.0f}s.")
        except LineTooLong:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            return TurnOutcome.failed("SuperGrok printed an event larger than the runtime reads.")
        finally:
            self._process = None
            for path in [*images, *([prompt_file] if prompt_file else [])]:
                with contextlib.suppress(OSError):
                    path.unlink()

    async def _run_turn(
        self,
        prompt: HarnessPrompt,
        model: str,
        text: str,
        prompt_file: Path | None,
        emit: EventSink,
    ) -> TurnOutcome:
        """One attempt, and one fresh retry when grok could not restore the session."""
        for attempt in range(2):
            resumed = session_dir(self.config.cli_home, self.session_id or "") is not None
            argv = self.build_argv(
                model,
                prompt.reasoning_effort,
                prompt_text=None if prompt_file else text,
                prompt_file=prompt_file,
            )
            state = GrokTurnState(message_id=prompt.message_id)
            outcome, kind = await self._run_attempt(argv, state, emit)
            if kind is FailureKind.RESTORE and resumed and attempt == 0 and not self._aborted:
                self.log.warn("grok.session.restore_failed", agent_session_id=self.session_id)
                await emit(
                    {"type": "warning", "scope": "provider", "message": SESSION_LOST_WARNING}
                )
                await self.create_session()
                continue
            return outcome
        raise AssertionError("unreachable")

    async def _run_attempt(
        self, argv: list[str], state: GrokTurnState, emit: EventSink
    ) -> tuple[TurnOutcome, FailureKind | None]:
        """One grok child: start it, stream its events, reap its group."""
        stderr_tail: collections.deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        stderr_task: asyncio.Task[None] | None = None
        outcome: TurnOutcome | None = None
        try:
            process = await spawn_group(
                argv,
                cwd=self.config.workdir,
                env=build_child_env(self.environ, self.config.cli_home),
                cli_label="grok",
            )
            self._process = process
            stderr_task = asyncio.create_task(
                read_stderr_tail(
                    process.stderr,
                    stderr_tail,
                    on_line=lambda line: self.log.debug("grok.stderr", line=line),
                )
            )
            assert process.stdout is not None
            async for line in read_lines_with_inactivity(
                process.stdout, self.limits.inactivity_timeout_seconds
            ):
                event = parse_event_line(line)
                if event is None:
                    continue
                translation = self._translator.translate(state, event)
                for bridge_event in translation.events:
                    await emit(bridge_event)
                if translation.outcome is not None:
                    outcome = translation.outcome
                    break
            returncode = await reap_group(
                process,
                self.limits.prompt_cleanup_timeout_seconds,
                log=self.log,
                log_prefix="grok",
            )
            if group_alive(process.pid):
                self.log.warn("grok.group_survived", pgid=process.pid)
            await asyncio.wait({stderr_task}, timeout=STDERR_SETTLE_SECONDS)
        finally:
            if stderr_task is not None:
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stderr_task
        if state.session_id and state.session_id != self.session_id:
            self.log.warn(
                "grok.session.adopted", agent_session_id=state.session_id, expected=self.session_id
            )
            self.session_id = state.session_id
        if outcome is not None:
            self.log.info(
                "grok.turn.finish",
                message_id=state.message_id,
                success=outcome.success,
                exit_code=returncode,
            )
            return outcome, state.failure_kind
        if self._aborted:
            return TurnOutcome(success=False, error="Task was cancelled", cancelled=True), None
        detail = " / ".join(stderr_tail) or "no output"
        kind, failed = failure_outcome(f"grok exited with code {returncode}: {detail}")
        self.log.warn("grok.turn.exit", exit_code=returncode, kind=kind.value)
        if kind is not FailureKind.RESTORE:
            await emit({"type": "error", "error": failed.error, "messageId": state.message_id})
        return failed, kind

    def _write_prompt_file(self, message_id: str, text: str) -> Path | None:
        """A 0600 file for a prompt too long for argv; ``None`` when it fits."""
        if len(text.encode("utf-8")) <= PROMPT_ARGV_LIMIT_BYTES:
            return None
        directory = self.config.config_dir / PROMPTS_DIR_NAME
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{uuid.uuid4().hex}.txt"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        self.log.info("grok.prompt_file", message_id=message_id, bytes=len(text.encode("utf-8")))
        return path

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
        process = self._process
        if process is None:
            return True
        return await terminate_group(process, timeout_seconds, log=self.log, log_prefix="grok")


def _with_attachments(text: str, images: list[Path]) -> str:
    """The prompt, naming attached images the agent can open with its read tool."""
    if not images:
        return text
    listing = "\n".join(f"- {path}" for path in images)
    return f"{text}\n\nAttached images:\n{listing}"
