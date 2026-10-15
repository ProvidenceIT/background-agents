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

A home with a login pool (``codex-pool/<slot>/auth.json``, see
``codex_pool``) runs each attempt on a picked slot: the harness links
``codex/auth.json`` to that slot's login before the child starts, and when
Codex reports a usage limit (or a refused login) it marks the slot and runs
the same turn on the next open one. ``sessions/`` and the rest of Codex's
state stay in ``codex/``, shared by every slot.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import contextlib
import json
import os
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Final

from . import codex_pool
from .base import (
    BridgeEvent,
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .claude_pool import read_headroom_file
from .codex_env import (
    AUTH_HOME_CODEX_AUTH,
    AUTH_HOME_CODEX_AUTH_MISSING,
    AUTH_HOME_CODEX_POOL_EMPTY,
    POOL_RELOGIN_HINT,
    codex_child_env,
    codex_home,
)
from .codex_pool import CONTINUE_PROMPT, CodexPick, FailureKind, LinkState
from .codex_tools import tool_server_overrides, write_tool_config
from .codex_translate import CodexTranslator, CodexTurnState, parse_event_line

if TYPE_CHECKING:
    from collections.abc import Mapping

    from ..log_config import StructuredLogger
    from .claude_tools import ToolServerConfig

CODEX_BINARY: Final = "codex"
DEFAULT_CODEX_MODEL: Final = "gpt-6-sol"
# One JSON line can carry a command's whole output.
STDOUT_LINE_LIMIT_BYTES: Final = 16 * 1024 * 1024
STDERR_TAIL_LINES: Final = 20
# How long a reaped child's stderr reader may take to reach the end of the pipe.
STDERR_SETTLE_SECONDS: Final = 1.0
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
# Pool mode only: a ``codex`` the agent runs in a tool shell must not find the
# pool's CODEX_HOME, or it would be a second writer of the slot's rotating
# refresh token. It gets an empty ``~/.codex`` and fails safely instead.
POOL_CONFIG_OVERRIDES: Final = ('shell_environment_policy.exclude=["CODEX_HOME"]',)
# Pool mode only, in the harness's config directory: the pid (and start time) of
# the Codex child that may be running, so a restarted bridge never switches the
# link under a child an earlier bridge left behind (W3).
CHILD_RECORD_FILE: Final = "sf-codex-child.json"


class _InactivityTimeout(Exception):
    """Codex printed nothing for longer than the inactivity budget."""


@dataclass
class _PoolTurn:
    """What one pool turn has done so far, across its attempts."""

    # Rebased onto a new thread once already (never twice in a turn).
    rebased: bool = False
    # The thread that carries this turn's partial work, if any attempt made progress.
    progress_thread: str | None = None


def _child_alive(record: Mapping[str, object]) -> bool:
    """Whether a listed child (``{pid, start}``) is still that same running process."""
    pid = record.get("pid")
    if not isinstance(pid, int):
        return False
    current = _process_start_time(pid)
    start = record.get("start")
    return current is not None and (start is None or current == start)


def _process_start_time(pid: int) -> str | None:
    """Field 22 of ``/proc/<pid>/stat`` (start time in clock ticks); ``None`` when gone."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fields = raw.rpartition(")")[2].split()
    # After the command name: state is field 3, so start time is index 22 - 3. A
    # zombie (or a dead task) holds no file open and writes nothing.
    if len(fields) <= 19 or fields[0] in ("Z", "X", "x"):
        return None
    return fields[19]


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
    return rollout_path(home, thread_id) is not None


def rollout_path(home: Path, thread_id: str) -> Path | None:
    """The thread's rollout file in the home, or ``None``."""
    try:
        uuid.UUID(thread_id)
    except ValueError:
        return None
    for path in sorted((home / "sessions").glob(f"*/*/*/rollout-*-{thread_id}.jsonl")):
        if path.is_file():
            return path
    return None


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
        self.auth_home: Path | None = None
        self._tool_config_path: Path | None = None
        self._translator = CodexTranslator()
        self._process: asyncio.subprocess.Process | None = None
        self._aborted = False
        # Login pool (codex_pool): on when the home has slots and codex/auth.json
        # is a pool link or absent; a regular file there keeps the legacy path.
        self._pool_root: Path = Path()
        self._pool_mode = False
        # Set when a child could not be confirmed gone: the link then stays put.
        self._pool_dirty = False
        # Between two attempts of one turn, when no child runs but abort must hold.
        self._in_failover = False
        self._slot: str | None = None

    @property
    def subscription_slot(self) -> str | None:
        """The pool slot the last attempt ran on (``codex-2``); ``None`` without a pool."""
        return self._slot if self._pool_mode else None

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Find the home's Codex login; a missing home or file is a start error."""
        self.codex_home = codex_home(self.environ)
        self.auth_home = self.codex_home.parent
        self._pool_root = codex_pool.pool_root(self.auth_home)
        slots = codex_pool.pool_slots(self._pool_root)
        link = codex_pool.link_state(self.codex_home, self._pool_root)
        self._pool_mode = bool(slots) and link in (LinkState.ABSENT, LinkState.POOL_LINK)
        if slots and not self._pool_mode:
            # The owner moves the old login into a slot (`--adopt-legacy`); never overwritten.
            self.log.warn("codex.pool.legacy_file", link=link.value, pool_slots=len(slots))
        for slot, reason in codex_pool.unusable_slots(self._pool_root).items():
            # Names only: an empty file is a login a killed refresh truncated.
            self.log.warn("codex.pool.slot_unusable", slot=slot, reason=reason)
        if self._pool_mode and self._earlier_child_alive():
            self._mark_pool_dirty("earlier_child_alive")
        if self.config.tools is not None:
            self._tool_config_path = write_tool_config(self.config.tools, self.config.config_dir)
        self.log.info(
            "codex.open",
            codex_home=str(self.codex_home),
            workdir=str(self.config.workdir),
            tools=self._tool_config_path is not None,
            pool_slots=len(slots) if self._pool_mode else 0,
        )

    async def close(self) -> None:
        process = self._process
        if await self._terminate(self.limits.prompt_cleanup_timeout_seconds) and process:
            self._clear_child_record(process.pid)

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
        if self._pool_mode:
            overrides.extend(POOL_CONFIG_OVERRIDES)
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
        # The owner can log out (or empty the pool) between turns; that needs
        # the owner, not a retry.
        if self._pool_mode:
            if not codex_pool.pool_slots(self._pool_root):
                raise HarnessStartError(AUTH_HOME_CODEX_POOL_EMPTY)
        elif not (home / "auth.json").is_file():
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
        # One deadline for the whole turn, however many slots it takes.
        deadline = asyncio.get_running_loop().time() + max_duration
        images = self._write_attachments(prompt)
        state = CodexTurnState(message_id=prompt.message_id)
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
                if self._pool_mode:
                    return await self._run_pool_turn(prompt, model, images, state, emit)
                argv = self.build_argv(model, prompt.reasoning_effort, images)
                return await self._run_attempt(argv, prompt.text, state, emit)
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
            process = self._process
            if self._pool_mode and process is not None and process.returncode is None:
                # W3: a child that may still run keeps its slot's login; never switch under it.
                self._mark_pool_dirty("child_not_confirmed_gone")
            if self._pool_mode and process is not None and process.returncode is not None:
                self._clear_child_record(process.pid)
            self._process = None
            self._in_failover = False
            for path in images:
                with contextlib.suppress(OSError):
                    path.unlink()

    async def _run_attempt(
        self, argv: list[str], text: str, state: CodexTurnState, emit: EventSink
    ) -> TurnOutcome:
        """One ``codex exec`` child: start it, stream its events, reap it."""
        home = self.codex_home
        assert home is not None
        stderr_tail: collections.deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        stderr_task: asyncio.Task[None] | None = None
        try:
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
            self._in_failover = False
            if self._pool_mode:
                self._write_child_record(process.pid)
            stderr_task = asyncio.create_task(self._drain_stderr(process, stderr_tail))
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(text.encode("utf-8"))
            await process.stdin.drain()
            process.stdin.close()
            outcome = await self._read_turn(process, state, emit)
            returncode = await self._reap(process)
            # Let the stderr reader reach the end, so the tail is complete.
            await asyncio.wait({stderr_task}, timeout=STDERR_SETTLE_SECONDS)
        finally:
            if stderr_task is not None:
                stderr_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stderr_task
        if outcome is not None:
            self.log.info(
                "codex.turn.finish",
                message_id=state.message_id,
                success=outcome.success,
                exit_code=returncode,
            )
            return outcome
        if self._aborted:
            return TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
        detail = " / ".join(stderr_tail) or "no output"
        if (
            self._pool_mode
            and state.failure_kind is None
            and codex_pool.classify_failure(detail) is FailureKind.USAGE_LIMIT
        ):
            state.failure_kind = FailureKind.USAGE_LIMIT
            state.failure_detail = detail
        return TurnOutcome.failed(
            f"Codex exited with code {returncode} before the turn completed: {detail}"
        )

    async def _run_pool_turn(
        self,
        prompt: HarnessPrompt,
        model: str,
        images: list[Path],
        state: CodexTurnState,
        emit: EventSink,
    ) -> TurnOutcome:
        """Attempts on pool slots until one settles the turn (see notes/sf-codex-pool.md).

        However the turn ends (outcome, cancel, deadline), the thread it leaves
        is remembered with the slot that ran it last, and a rebased thread that
        neither succeeded nor did any work is dropped again: the conversation
        keeps its own thread, and the next turn rebases afresh with the handoff.
        """
        turn_thread = self.session_id
        turn = _PoolTurn()
        outcome: TurnOutcome | None = None
        try:
            outcome = await self._pool_attempts(prompt, model, images, state, emit, turn)
            return outcome
        finally:
            if state.progress:
                turn.progress_thread = self.session_id
            succeeded = outcome is not None and outcome.success
            if (
                not succeeded
                and turn_thread is not None
                and self.session_id != turn_thread
                and (self.session_id is None or self.session_id != turn.progress_thread)
            ):
                self.log.info(
                    "codex.pool.rebase_dropped",
                    agent_session_id=turn_thread,
                    dropped=self.session_id,
                )
                self.session_id = turn_thread
            else:
                self._remember_thread()

    async def _pool_attempts(
        self,
        prompt: HarnessPrompt,
        model: str,
        images: list[Path],
        state: CodexTurnState,
        emit: EventSink,
        turn: _PoolTurn,
    ) -> TurnOutcome:
        """The attempt loop of ``_run_pool_turn``.

        A usage limit or a refused login marks the slot and moves the same turn
        to the next open slot; a thread another account made is rebased once
        onto a new thread. Anything else settles the turn as a single attempt
        would. The held failure events are released whenever no failover follows.
        """
        home, root = self.codex_home, self._pool_root
        assert home is not None
        if not self._pool_dirty and self._earlier_child_alive():
            self._mark_pool_dirty("earlier_child_alive")
        text = prompt.text
        tried: list[str] = []
        # Pins the next attempt to the slot a rebase happened on.
        rebase_slot: str | None = None
        failed_over_from: tuple[str, FailureKind] | None = None
        announced = False
        last: tuple[TurnOutcome, FailureKind, str, list[BridgeEvent]] | None = None
        max_attempts = len(codex_pool.pool_slots(root)) + 2
        for attempt in range(max_attempts):
            if rebase_slot is not None:
                pick: CodexPick | None = CodexPick(
                    rebase_slot, root / rebase_slot / codex_pool.AUTH_FILE, "rebase", None
                )
            elif self._pool_dirty:
                current = codex_pool.linked_slot(home, root) if attempt == 0 else None
                pick = (
                    CodexPick(current, root / current / codex_pool.AUTH_FILE, "pinned", None)
                    if current
                    else None
                )
            else:
                pick = codex_pool.pick_codex_slot(
                    root,
                    thread_id=self.session_id,
                    tried=tried,
                    first_attempt=attempt == 0,
                    codex_dir=home,
                )
            if pick is None:
                if last is None and self._pool_dirty:
                    raise HarnessStartError(
                        f"{AUTH_HOME_CODEX_AUTH} cannot be switched to a pool slot while an "
                        "earlier Codex child may still run; start a new session."
                    )
                if last is None:
                    raise HarnessStartError(AUTH_HOME_CODEX_POOL_EMPTY)
                return await self._no_slot_left(state, emit, tried, last)
            if failed_over_from is not None and not announced:
                announced = True
                old, why = failed_over_from
                cause = (
                    "hit its usage limit"
                    if why is FailureKind.USAGE_LIMIT
                    else "was refused by OpenAI"
                )
                self.log.info("codex.pool.failover", from_slot=old, to_slot=pick.slot, cause=why)
                await emit(
                    {
                        "type": "warning",
                        "scope": "provider",
                        "message": f"Codex slot {old} {cause}; continued on {pick.slot}.",
                    }
                )
            if self._aborted:
                return TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
            if not self._pool_dirty:
                try:
                    codex_pool.point_auth(home, root, pick.slot)
                except (OSError, ValueError) as error:
                    self.log.error("codex.pool.link_failed", slot=pick.slot, error=str(error))
                    message = (
                        f"Codex could not switch {AUTH_HOME_CODEX_AUTH} to pool slot "
                        f"{pick.slot}: {error}"
                    )
                    await emit({"type": "error", "error": message, "messageId": state.message_id})
                    return TurnOutcome.failed(message)
            self._slot = pick.slot
            self._write_pick_record(pick, attempt)
            self.log.info(
                "codex.pool.pick",
                slot=pick.slot,
                reason=pick.reason,
                percent_remaining=pick.percent_remaining,
                attempt=attempt,
                resume=self.session_id is not None,
            )
            state.relogin_hint = POOL_RELOGIN_HINT.format(slot=pick.slot)
            session_before = self.session_id
            argv = self.build_argv(model, prompt.reasoning_effort, images)
            outcome = await self._run_attempt(argv, text, state, emit)
            kind = state.failure_kind
            process = self._process
            exited = process is None or process.returncode is not None
            if state.progress:
                turn.progress_thread = self.session_id
            if (
                outcome.success
                or outcome.cancelled
                or self._aborted
                or kind is None
                or kind is FailureKind.OTHER
            ):
                return await self._release(state, emit, outcome)
            if not exited:
                self._mark_pool_dirty("child_not_confirmed_gone")
                return await self._release(state, emit, outcome)
            self._process = None
            self._in_failover = True
            detail = state.failure_detail or outcome.error or ""
            if kind is FailureKind.FOREIGN_THREAD:
                if session_before is None or state.progress or turn.rebased:
                    return await self._release(state, emit, outcome)
                rollout = rollout_path(home, session_before)
                text = codex_pool.build_handoff_prompt(rollout, text)
                self.session_id = None
                turn.rebased = True
                rebase_slot = pick.slot
                self.log.warn("codex.pool.rebase", slot=pick.slot, agent_session_id=session_before)
                await emit(
                    {
                        "type": "warning",
                        "scope": "provider",
                        "message": (
                            f"Codex could not resume this conversation's thread on slot "
                            f"{pick.slot}; the conversation continues in a new thread that "
                            "starts from the earlier transcript."
                        ),
                    }
                )
                state.reset_for_retry()
                continue
            rebase_slot = None
            if self._pool_dirty:
                return await self._release(state, emit, outcome)
            now = time.time()
            if kind is FailureKind.USAGE_LIMIT:
                _, readings = read_headroom_file(root / codex_pool.HEADROOM_FILE)
                until, source = codex_pool.exhaustion_mark(detail, readings.get(pick.slot, []), now)
                with contextlib.suppress(OSError):
                    codex_pool.mark_exhausted(root, pick.slot, until, now=now, source=source)
                self.log.warn(
                    "codex.pool.exhausted",
                    slot=pick.slot,
                    until=codex_pool.iso(until),
                    source=source,
                )
            else:
                with contextlib.suppress(OSError):
                    codex_pool.mark_auth_refused(root, pick.slot, now=now)
                self.log.warn("codex.pool.auth_refused", slot=pick.slot)
                await emit(
                    {
                        "type": "warning",
                        "scope": "provider",
                        "message": (
                            f"Codex subscription slot {pick.slot} was refused by OpenAI "
                            f"({detail}); re-enrol it with `sf-enrol-auth-home.sh <user> "
                            f"--codex-slot {pick.slot}`."
                        ),
                    }
                )
            tried.append(pick.slot)
            if failed_over_from is None:
                failed_over_from = (pick.slot, kind)
            last = (outcome, kind, detail, list(state.held))
            if self.session_id and self.session_id == turn.progress_thread:
                # Never replay a prompt whose work has partly happened in this thread.
                text = CONTINUE_PROMPT
            elif session_before is None:
                # The failed attempt's new thread is dropped; the retry starts a fresh one
                # with the same text (the prompt, or the rebase's handoff).
                self.session_id = None
            state.reset_for_retry()
        assert last is not None
        return await self._no_slot_left(state, emit, tried, last)

    async def _no_slot_left(
        self,
        state: CodexTurnState,
        emit: EventSink,
        tried: list[str],
        last: tuple[TurnOutcome, FailureKind, str, list[BridgeEvent]],
    ) -> TurnOutcome:
        outcome, kind, detail, held = last
        if kind is not FailureKind.USAGE_LIMIT:
            for event in held:
                await emit(event)
            return outcome
        reset = codex_pool.earliest_reset(self._pool_root, codex_pool.pool_slots(self._pool_root))
        message = (
            "Codex turn failed: every Codex subscription slot is at its limit (earliest reset "
            f"{codex_pool.iso(reset) if reset is not None else 'unknown'}): {detail}"
        )
        self.log.warn("codex.pool.all_exhausted", tried=tried)
        await emit({"type": "error", "error": message, "messageId": state.message_id})
        return TurnOutcome.failed(message)

    async def _release(
        self, state: CodexTurnState, emit: EventSink, outcome: TurnOutcome
    ) -> TurnOutcome:
        """Emit what the attempt held back and settle the turn with its outcome."""
        held, state.held = state.held, []
        for event in held:
            await emit(event)
        return outcome

    def _remember_thread(self) -> None:
        """Which slot ran the thread last, so its next turn sticks to it."""
        if self.session_id and self._slot:
            with contextlib.suppress(OSError):
                codex_pool.record_thread_slot(self._pool_root, self.session_id, self._slot)

    def _write_child_record(self, pid: int) -> None:
        """Add a Codex child that may run, by pid and start time (W3 across bridge restarts).

        Every child stays listed until it is confirmed gone, so a later child
        never hides an earlier one that outlived its turn.
        """
        children = [c for c in self._child_records() or [] if _child_alive(c)]
        children.append({"pid": pid, "start": _process_start_time(pid)})
        try:
            self.config.config_dir.mkdir(parents=True, exist_ok=True)
            (self.config.config_dir / CHILD_RECORD_FILE).write_text(json.dumps(children))
        except OSError as error:
            self.log.warn("codex.pool.child_record_failed", error=str(error))

    def _clear_child_record(self, pid: int) -> None:
        """Drop ``pid`` (confirmed gone) and every listed child that has ended since."""
        records = self._child_records()
        if records is None:
            return
        children = [c for c in records if c.get("pid") != pid and _child_alive(c)]
        path = self.config.config_dir / CHILD_RECORD_FILE
        with contextlib.suppress(OSError):
            if children:
                path.write_text(json.dumps(children))
            else:
                path.unlink(missing_ok=True)

    def _child_records(self) -> list[dict[str, object]] | None:
        """The listed children; ``None`` when the list cannot be read."""
        try:
            raw = json.loads((self.config.config_dir / CHILD_RECORD_FILE).read_text())
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            return None
        if not isinstance(raw, list):
            return None
        return [c for c in raw if isinstance(c, dict)]

    def _earlier_child_alive(self) -> bool:
        """Whether a listed Codex child, other than this harness's own live one, still runs."""
        records = self._child_records()
        if records is None:
            return True  # unreadable: assume the worst, the link must not move
        own = self._process
        own_pid = own.pid if own is not None and own.returncode is None else None
        return any(c.get("pid") != own_pid and _child_alive(c) for c in records)

    def _mark_pool_dirty(self, reason: str) -> None:
        if not self._pool_dirty:
            self._pool_dirty = True
            self.log.warn("codex.pool.dirty", reason=reason, slot=self._slot)

    def _write_pick_record(self, pick: CodexPick, attempt: int) -> None:
        """Which slot this attempt spends, by name only (never a token)."""
        record = {
            "slot": pick.slot,
            "reason": pick.reason,
            "percentRemaining": pick.percent_remaining,
            "attempt": attempt,
            "at": int(time.time()),
        }
        try:
            self.config.config_dir.mkdir(parents=True, exist_ok=True)
            (self.config.config_dir / codex_pool.PICK_FILE).write_text(json.dumps(record))
        except OSError as error:
            self.log.warn("codex.pool.pick_record_failed", error=str(error))

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
            if translation.hold and self._pool_mode:
                state.held.extend(translation.events)
            else:
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
            if self._in_failover:
                # Between two attempts: the next one never starts.
                self._aborted = True
                return True
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
