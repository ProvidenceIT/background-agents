"""Bridge half of the Antigravity harness: one ``agy -p`` child per turn.

Antigravity reaches a session only through the access token the owner's
machine pushes into the subscription home (``pushed_token``); the Google
refresh token never enters a sandbox. Before every turn the harness checks
that token (``agy_env.preflight``) and writes it as agy's access-only login,
then runs

    agy -p <prompt> --output-format stream-json --dangerously-skip-permissions
        --model <m> [--effort <e>] [--conversation <id>]

in the workdir, in its own process group, on the pod's ``HOME``. A prompt
over ``PROMPT_ARGV_LIMIT_BYTES`` (one argv string is capped at 128 KiB on
Linux) goes in as the single stdin line of ``--input-format stream-json -p ""``
instead; agy exits once stdin is closed and the turn is done.

agy loads its login when it starts and keeps it in memory, so a turn cannot
outlive the pushed token: the turn deadline is capped at the token's expiry
less ``TOKEN_EXPIRY_MARGIN_SECONDS``. The token file is still rewritten every
``TOKEN_REWRITE_SECONDS`` from the newest push while a turn runs, for an agy
that does re-read it. A login prompt on stderr ends the turn at once: nothing
in the sandbox can log in.

``AgyTranslator`` turns agy's events into bridge events. The conversation id
is the one agy reports; the bridge persists it, and the next turn resumes it
with ``--conversation`` while ``~/.gemini/antigravity-cli/conversations/<id>.db``
is still there. agy starts a fresh conversation (and still succeeds) for an id
it lost; the turn then warns and adopts the new id.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import os
import re
import signal
from pathlib import Path
from typing import TYPE_CHECKING, Final

from .. import pushed_token
from . import agy_env, cli_process
from .agy_translate import (
    LOST_CONVERSATION_WARNING,
    AgyTranslator,
    AgyTurnState,
    FailureKind,
    classify_failure,
    failure_outcome,
    parse_event_line,
)
from .base import (
    ANTHROPIC_MODEL_REFUSAL,
    NO_MODEL_SELECTED,
    AgyHarnessConfig,
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .claude_env import AUTH_HOME_ENV_VAR, AUTH_HOME_PROVIDERS_ENV_VAR

if TYPE_CHECKING:
    from collections.abc import Mapping

    from ..log_config import StructuredLogger
    from ..pushed_token import PushedToken

CLI_LABEL: Final = "agy"
PROVIDER_PREFIX: Final = "antigravity"
# Below Linux's 128 KiB cap on one argv string, with room for the rest.
PROMPT_ARGV_LIMIT_BYTES: Final = 100 * 1024
# How often a running agy's process tree is listed. A command agy detaches goes
# to init once agy exits, out of reach of ``descendants``.
DESCENDANT_SCAN_SECONDS: Final = 0.5
# A turn ends this long before the pushed token does: agy holds it in memory.
TOKEN_EXPIRY_MARGIN_SECONDS: Final = 120.0
TOKEN_REWRITE_SECONDS: Final = 60.0
# How long a reaped child's stderr reader may take to reach the end of the pipe.
STDERR_SETTLE_SECONDS: Final = 1.0
# agy's --effort values; anything else is left to the model's default.
EFFORTS: Final = frozenset({"low", "medium", "high", "xhigh", "max"})
# Models agy knows only with the effort in the id; ``--effort`` then conflicts.
FIXED_EFFORT_MODELS: Final[Mapping[str, str]] = {"gpt-oss-120b": "gpt-oss-120b-medium"}
_EFFORT_SUFFIX = re.compile(r"-(low|medium|high)$")


class ModelRefused(ValueError):
    """A model the Antigravity harness must not run; the message is user-facing."""


def model_args(model: str | None, reasoning_effort: str | None) -> list[str]:
    """``--model <m> [--effort <e>]`` for a catalog id, or ``ModelRefused``.

    ``antigravity/gemini-4-argon`` with ``high`` is ``--model gemini-4-argon
    --effort high``. agy also serves Claude models, which run only on the
    Claude Agent harness, so any ``claude*`` id is refused, as is any other
    provider.
    """
    value = (model or "").strip()
    if not value:
        raise ModelRefused(NO_MODEL_SELECTED)
    provider, _, bare = value.rpartition("/")
    if provider == "anthropic" or bare.lower().startswith("claude"):
        raise ModelRefused(ANTHROPIC_MODEL_REFUSAL)
    if provider and provider != PROVIDER_PREFIX:
        raise ModelRefused(f"The Antigravity harness cannot run provider {provider!r}")
    if bare in FIXED_EFFORT_MODELS:
        return ["--model", FIXED_EFFORT_MODELS[bare]]
    if _EFFORT_SUFFIX.search(bare) or reasoning_effort not in EFFORTS:
        return ["--model", bare]
    assert reasoning_effort is not None
    return ["--model", bare, "--effort", reasoning_effort]


def stdin_message(text: str) -> bytes:
    """The one ``--input-format stream-json`` line that carries a large prompt."""
    line = {"event": "user", "message": {"role": "user", "content": text}}
    return (json.dumps(line) + "\n").encode("utf-8")


class AgyHarness:
    """``AgentHarness`` over the Antigravity CLI."""

    id = HarnessId.AGY

    def __init__(
        self,
        config: AgyHarnessConfig,
        log: StructuredLogger,
        limits: PromptLimits,
        *,
        environ: Mapping[str, str] | None = None,
        token_rewrite_seconds: float = TOKEN_REWRITE_SECONDS,
    ) -> None:
        self.config = config
        self.log = log
        self.limits = limits
        self.environ: Mapping[str, str] = os.environ if environ is None else environ
        self.token_rewrite_seconds = token_rewrite_seconds
        self.session_id: str | None = None
        self._translator = AgyTranslator()
        self._process: asyncio.subprocess.Process | None = None
        self._aborted = False
        self._auth_failure: str | None = None
        self._account_tag: str | None = None
        self._kill_task: asyncio.Task[bool] | None = None
        # agy started a fresh conversation in place of the one asked for; the
        # memory notes it never saw go ahead of the next prompt.
        self._memory_pending = False
        # Every process seen below the running agy, as pid -> start time.
        self._seen_descendants: dict[int, str] = {}

    @property
    def subscription_slot(self) -> str | None:
        """``agy-<account tag>`` of the pushed login the last turn ran on.

        The wire allows only ``[A-Za-z0-9._-]`` in a slot (``subscriptionSlotSchema``),
        and the control plane drops an ``execution_complete`` whose slot breaks it.
        """
        return f"agy-{self._account_tag}" if self._account_tag else None

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Register the ``oi`` tools with agy; a home not enrolled for Antigravity cannot start.

        A stale or missing push is not final (the next push fixes it), so it
        fails a turn rather than the harness.
        """
        spec = pushed_token.PUSHED_CLIS["agy"]
        if not self.environ.get(AUTH_HOME_ENV_VAR):
            raise HarnessStartError(
                f"{spec.label} needs a subscription home, and this session has none mounted."
            )
        providers = {
            p.strip() for p in self.environ.get(AUTH_HOME_PROVIDERS_ENV_VAR, "").split(",")
        }
        if spec.provider not in providers:
            raise HarnessStartError(f"{spec.label} not enrolled for this home.")
        agy_env.write_mcp_config(self.config.cli_home, self.config.tool_config_path)
        self.log.info(
            "agy.open",
            home=str(self.config.cli_home),
            workdir=str(self.config.workdir),
            tools=self.config.tool_config_path is not None,
        )

    async def close(self) -> None:
        await self._terminate(self.limits.prompt_cleanup_timeout_seconds)

    async def resume_session(self, persisted_id: str) -> bool:
        if not agy_env.conversation_exists(self.config.cli_home, persisted_id):
            self.log.info("agy.session.invalid", agent_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        self.log.info("agy.session.ensure", agent_session_id=persisted_id, action="loaded")
        return True

    async def create_session(self) -> None:
        # agy names the conversation itself; the first turn's init sets the id.
        self.session_id = None
        self.log.info("agy.session.ensure", action="deferred_to_first_turn")

    # --- turns ---------------------------------------------------------------

    def build_argv(self, model: list[str], *, stdin_prompt: bool, text: str) -> list[str]:
        argv = [self.config.binary, "-p", "" if stdin_prompt else text]
        if stdin_prompt:
            argv.extend(["--input-format", "stream-json"])
        argv.extend(["--output-format", "stream-json", "--dangerously-skip-permissions", *model])
        if self.session_id:
            argv.extend(["--conversation", self.session_id])
        return argv

    def turn_text(self, prompt: HarnessPrompt) -> str:
        """The prompt, with the memory notes ahead of it when a conversation starts."""
        memory = self.config.memory_text
        if self._needs_memory() and memory:
            return f"{memory}\n\n---\n\n{prompt.text}"
        return prompt.text

    def _needs_memory(self) -> bool:
        """agy has no per-turn rules flag: a conversation gets the notes in its first prompt."""
        return self.session_id is None or self._memory_pending

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        try:
            model = model_args(prompt.model or self.config.default_model, prompt.reasoning_effort)
        except ModelRefused as error:
            return TurnOutcome.failed(str(error))
        try:
            token = agy_env.preflight(self.environ)
        except HarnessStartError as error:
            self.log.warn("agy.preflight_failed", error=str(error))
            return TurnOutcome.failed(str(error))
        self._account_tag = token.account_tag
        self._translator.stale_hint = pushed_token.stale_message(token)
        agy_env.write_token(self.config.cli_home, token)
        max_duration = (
            self.limits.prompt_max_duration_seconds
            if prompt.max_duration_seconds is None
            else prompt.max_duration_seconds
        )
        token_budget = token.expires_in_seconds() - TOKEN_EXPIRY_MARGIN_SECONDS
        budget = min(max_duration, token_budget)
        if self.session_id is not None and not agy_env.conversation_exists(
            self.config.cli_home, self.session_id
        ):
            # Asking for it would get a fresh conversation without the memory notes.
            self.log.warn("agy.session.lost", requested=self.session_id)
            await emit(
                {"type": "warning", "scope": "provider", "message": LOST_CONVERSATION_WARNING}
            )
            self.session_id = None
        with_memory = self._needs_memory()
        text = self.turn_text(prompt)
        stdin_prompt = len(text.encode("utf-8")) > PROMPT_ARGV_LIMIT_BYTES
        argv = self.build_argv(model, stdin_prompt=stdin_prompt, text=text)
        state = AgyTurnState(message_id=prompt.message_id)
        self._aborted = False
        self._auth_failure = None
        if prompt.attachments:
            await emit(
                {
                    "type": "warning",
                    "scope": "provider",
                    "message": "Antigravity cannot see attached images yet; they were left out.",
                }
            )
        self.log.info(
            "agy.turn.start",
            message_id=prompt.message_id,
            model=model[1],
            resume=self.session_id is not None,
            stdin_prompt=stdin_prompt,
            budget_s=int(budget),
        )
        refresher = asyncio.create_task(self._rewrite_token(token))
        try:
            async with asyncio.timeout(budget):
                outcome = await self._run_child(argv, text if stdin_prompt else None, state, emit)
            if outcome.success and with_memory:
                self._memory_pending = False
            return outcome
        except asyncio.CancelledError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            raise
        except TimeoutError:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            if token_budget < max_duration:
                return TurnOutcome.failed(
                    "Prompt stopped before the pushed Antigravity login expires "
                    f"({budget:.0f}s); send it again once a fresh push lands."
                )
            return TurnOutcome.failed(f"Prompt exceeded max duration of {max_duration:.0f}s.")
        except cli_process.InactivityTimeout:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            timeout_seconds = self.limits.inactivity_timeout_seconds
            self.log.error("agy.inactivity_timeout", timeout_s=timeout_seconds)
            return TurnOutcome.failed(f"Antigravity produced no output for {timeout_seconds:.0f}s.")
        except cli_process.LineTooLong:
            await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            return TurnOutcome.failed(
                "Antigravity printed an event larger than the bridge accepts."
            )
        finally:
            refresher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await refresher
            self._process = None

    async def _run_child(
        self, argv: list[str], stdin_text: str | None, state: AgyTurnState, emit: EventSink
    ) -> TurnOutcome:
        """One ``agy`` child: start it, stream its events, reap it."""
        requested = self.session_id
        stderr_tail: collections.deque[str] = collections.deque(
            maxlen=cli_process.STDERR_TAIL_LINES
        )
        process = await cli_process.spawn_group(
            argv,
            cwd=self.config.workdir,
            env=agy_env.child_env(self.environ, self.config.cli_home),
            cli_label=CLI_LABEL,
            stdin_pipe=stdin_text is not None,
        )
        self._process = process
        tasks: list[asyncio.Task[None]] = []
        stderr_task = asyncio.create_task(
            cli_process.read_stderr_tail(process.stderr, stderr_tail, on_line=self._on_stderr)
        )
        if stdin_text is not None:
            tasks.append(asyncio.create_task(self._write_stdin(process, stdin_text)))
        tasks.append(asyncio.create_task(self._track_descendants(process)))
        outcome: TurnOutcome | None = None
        try:
            assert process.stdout is not None
            async for line in cli_process.read_lines_with_inactivity(
                process.stdout, self.limits.inactivity_timeout_seconds
            ):
                event = parse_event_line(line)
                if event is None:
                    continue
                translation = self._translator.translate(state, event)
                for bridge_event in translation.events:
                    await emit(bridge_event)
                await self._adopt_conversation(state, requested, emit)
                if translation.outcome is not None:
                    outcome = translation.outcome
                    break
            self._note_descendants(process)
            returncode = await self._reap(process)
            await asyncio.wait({stderr_task}, timeout=STDERR_SETTLE_SECONDS)
        finally:
            for task in (stderr_task, *tasks):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if self._aborted and (outcome is None or not outcome.success):
            # agy answers a stop with an "interrupted" result; the stop is what happened.
            return TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
        if self._auth_failure is not None and (outcome is None or not outcome.success):
            # The login prompt is the cause, whatever agy printed after it.
            return failure_outcome(self._auth_failure, stale_hint=self._translator.stale_hint)
        if outcome is not None:
            self.log.info(
                "agy.turn.finish",
                message_id=state.message_id,
                success=outcome.success,
                exit_code=returncode,
                failure=state.failure_kind,
            )
            return outcome
        detail = " / ".join(stderr_tail) or "no output"
        if classify_failure(detail) is not FailureKind.OTHER:
            return failure_outcome(detail, stale_hint=self._translator.stale_hint)
        return TurnOutcome.failed(
            f"Antigravity exited with code {returncode} before the turn completed: {detail}"
        )

    async def _adopt_conversation(
        self, state: AgyTurnState, requested: str | None, emit: EventSink
    ) -> None:
        reported = state.conversation_id
        if not reported or reported == self.session_id:
            return
        if requested is not None:
            self.log.warn("agy.session.lost", requested=requested, agent_session_id=reported)
            await emit(
                {"type": "warning", "scope": "provider", "message": LOST_CONVERSATION_WARNING}
            )
            self._memory_pending = True
        self.session_id = reported
        self.log.info("agy.session.ensure", agent_session_id=reported, action="created")

    def _on_stderr(self, line: str) -> None:
        self.log.debug("agy.stderr", line=line)
        if self._auth_failure is None and classify_failure(line) is FailureKind.AUTH:
            # agy waits a minute for a browser login nobody can give; stop it now.
            self._auth_failure = line
            self.log.warn("agy.login_prompt")
            self._kill_task = asyncio.get_running_loop().create_task(
                self._terminate(self.limits.prompt_cleanup_timeout_seconds)
            )

    async def _write_stdin(self, process: asyncio.subprocess.Process, text: str) -> None:
        assert process.stdin is not None
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            process.stdin.write(stdin_message(text))
            await process.stdin.drain()
            process.stdin.close()

    async def _rewrite_token(self, current: PushedToken) -> None:
        """Every ``token_rewrite_seconds``, write the newest push into agy's token file."""
        home = Path(self.environ[AUTH_HOME_ENV_VAR])
        path = pushed_token.access_path(home, "agy")
        while True:
            await asyncio.sleep(self.token_rewrite_seconds)
            try:
                latest = pushed_token.read_file(path, "agy")
                if latest.expires_at >= current.expires_at:
                    agy_env.write_token(self.config.cli_home, latest)
                    current = latest
            except (HarnessStartError, OSError) as error:
                self.log.warn("agy.token_rewrite_failed", error=str(error))

    # --- stopping ------------------------------------------------------------

    async def abort(self) -> bool:
        if self._process is None or self._process.returncode is not None:
            return False
        self._aborted = True
        await self._terminate(self.limits.prompt_cleanup_timeout_seconds)
        return True

    async def stop_execution(self, timeout_seconds: float) -> bool:
        return await self._terminate(timeout_seconds)

    async def _reap(self, process: asyncio.subprocess.Process) -> int | None:
        """Wait for an agy that reported its result; one that lingers is stopped tree and all.

        ``cli_process.reap_group`` would stop only the group, and miss the
        commands agy runs in sessions of their own.
        """
        timeout_seconds = self.limits.prompt_cleanup_timeout_seconds
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(timeout_seconds):
                await process.wait()
        if (
            process.returncode is None
            or cli_process.group_alive(process.pid)
            or self._live_seen_descendants()
        ):
            await self._terminate(timeout_seconds)
        self._seen_descendants.clear()
        return process.returncode

    async def _track_descendants(self, process: asyncio.subprocess.Process) -> None:
        while process.returncode is None:
            self._note_descendants(process)
            await asyncio.sleep(DESCENDANT_SCAN_SECONDS)

    def _note_descendants(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            self._seen_descendants.update(descendants(process.pid))

    def _live_seen_descendants(self) -> list[tuple[int, str]]:
        return [
            (pid, start)
            for pid, start in self._seen_descendants.items()
            if _start_time(pid) == start
        ]

    async def _terminate(self, timeout_seconds: float) -> bool:
        """Stop agy's process group and every process it started outside it.

        agy runs a command on its own terminal, in a session of its own, so
        the group alone misses it; the tree is listed while agy still holds it.
        """
        process = self._process
        if process is None:
            return True
        self._note_descendants(process)
        strays = self._live_seen_descendants()
        signal_processes(strays, signal.SIGTERM)
        done = await cli_process.terminate_group(
            process, timeout_seconds, log=self.log, log_prefix="agy"
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(timeout_seconds / 2, 0.1)
        while (
            alive := [p for p in strays if _start_time(p[0]) == p[1]]
        ) and loop.time() < deadline:
            await asyncio.sleep(0.05)
        if alive:
            signal_processes(alive, signal.SIGKILL)
            self.log.warn("agy.terminate_strays", count=len(alive))
        self._seen_descendants.clear()
        return done


def _start_time(pid: int) -> str | None:
    """Field 22 of ``/proc/<pid>/stat``; ``None`` once the process is gone or a zombie."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fields = raw.rpartition(")")[2].split()
    if len(fields) <= 19 or fields[0] in ("Z", "X", "x"):
        return None
    return fields[19]


def descendants(pid: int) -> list[tuple[int, str]]:
    """Every live process below ``pid``, as ``(pid, start time)``, whatever its session."""
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fields = raw.rpartition(")")[2].split()
        if len(fields) > 1 and fields[1].isdigit():
            children.setdefault(int(fields[1]), []).append(int(entry.name))
    found: list[tuple[int, str]] = []
    pending = list(children.get(pid, []))
    while pending:
        child = pending.pop()
        start = _start_time(child)
        if start is not None:
            found.append((child, start))
        pending.extend(children.get(child, []))
    return found


def signal_processes(processes: list[tuple[int, str]], sig: signal.Signals) -> None:
    """Signal each listed process that is still the one listed (not a reused pid)."""
    for pid, start in processes:
        if _start_time(pid) == start:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, sig)
