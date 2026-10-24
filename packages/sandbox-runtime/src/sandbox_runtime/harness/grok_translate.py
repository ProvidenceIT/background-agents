"""``grok -p --output-format streaming-json`` events in the bridge's event model.

grok prints one ACP session update per line (grok 1.0.52):

- ``available_commands {tools}``: the tool list, repeated; ignored;
- ``text {data}`` / ``thought {data}``: answer and reasoning deltas;
- ``tool_call {toolCallId, toolName, rawInput, status}``, then
  ``tool_call_update {toolCallId, status, content, rawOutput}`` until the
  status is ``completed`` or ``failed``. MCP tools arrive through the
  built-in ``use_tool`` (``rawInput {tool_name: "<server>__<tool>",
  tool_input}``);
- ``usage {usage}`` per model call;
- ``end {stopReason, sessionId, usage, total_cost_usd}``: the turn is over;
- ``error {message}``: the turn failed (``Not signed in``, for one).

The translator keeps per-turn state only. A ``token`` event carries the
turn's whole text so far (text after a tool call starts a new paragraph),
and a tool call is reported ``running`` when it starts and ``completed`` or
``error`` when its last update arrives, under its ``toolCallId``.

Only the success shapes were recorded. Failures are recognised by text in
``FAILURE_PATTERNS``, one table to extend as new shapes are seen.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Final, Literal

from .base import BridgeEvent, SubscriptionLimit, TurnOutcome
from .grok_env import OI_TOOL_SERVER_NAME

if TYPE_CHECKING:
    from collections.abc import Mapping

ToolStatus = Literal["running", "completed", "error"]

# grok's tools under the names OpenCode and Claude show; others pass through.
TOOL_NAMES: Final = {
    "run_terminal_command": "bash",
    "search_replace": "edit",
    "edit_file": "edit",
    "read_file": "read",
}
# The built-in that calls an MCP tool by its ``<server>__<tool>`` name.
MCP_CALL_TOOL: Final = "use_tool"
MCP_NAME_SEPARATOR: Final = "__"

STALE_PUSH_HINT: Final = (
    "the pushed SuperGrok credential may be stale or refused: check sf-cred-push.timer on "
    "the owner's machine, and `grok login` there if it reports a login failure"
)


class FailureKind(StrEnum):
    AUTH = "auth"
    USAGE_LIMIT = "usage_limit"
    # ``-r <id>`` named a session grok could not find locally or remotely.
    RESTORE = "restore"
    OTHER = "other"


# First match wins; matched case-insensitively against the error text or stderr tail.
FAILURE_PATTERNS: Final[tuple[tuple[FailureKind, re.Pattern[str]], ...]] = (
    (FailureKind.RESTORE, re.compile(r"failed to restore session", re.IGNORECASE)),
    (
        FailureKind.USAGE_LIMIT,
        re.compile(r"\b429\b|too many requests|rate.?limit|usage limit", re.IGNORECASE),
    ),
    (
        FailureKind.AUTH,
        re.compile(
            r"not signed in|GROK_AUTH_EXPIRED|\b40[13]\b|unauthorized|forbidden"
            r"|credential push stale|not enrolled for this home",
            re.IGNORECASE,
        ),
    ),
)


def classify_failure(detail: str) -> FailureKind:
    for kind, pattern in FAILURE_PATTERNS:
        if pattern.search(detail):
            return kind
    return FailureKind.OTHER


def failure_outcome(detail: str) -> tuple[FailureKind, TurnOutcome]:
    """The user-facing failure for ``detail``, by kind."""
    kind = classify_failure(detail)
    if kind is FailureKind.USAGE_LIMIT:
        return kind, TurnOutcome.failed(
            f"SuperGrok usage limit reached: {detail}", limit=SubscriptionLimit.of("unknown")
        )
    if kind is FailureKind.AUTH:
        return kind, TurnOutcome.failed(f"SuperGrok was refused: {detail}; {STALE_PUSH_HINT}.")
    return kind, TurnOutcome.failed(f"SuperGrok turn failed: {detail}")


@dataclass
class GrokTurnState:
    """What one turn has produced so far."""

    message_id: str
    step_id: str | None = None
    text: str = ""
    last_token_content: str | None = None
    # A tool ran since the last text: the next text starts a new paragraph.
    text_break: bool = False
    # Tool calls by toolCallId: (bridge name, args), as their start reported them.
    tools: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    finished_tools: set[str] = field(default_factory=set)
    usage: dict[str, Any] | None = None
    # The ``end`` event's sessionId, when there was one.
    session_id: str | None = None
    terminal: bool = False
    failure_kind: FailureKind | None = None


@dataclass(frozen=True)
class GrokTranslation:
    events: list[BridgeEvent]
    outcome: TurnOutcome | None = None


def parse_event_line(line: str | bytes) -> dict[str, Any] | None:
    """One stdout line as an event; anything else (logs, blank lines) is ``None``."""
    text = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else line
    text = text.strip()
    if not text.startswith("{"):
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) and isinstance(parsed.get("type"), str) else None


class GrokTranslator:
    """Stateless across turns; all state lives in ``GrokTurnState``."""

    def translate(self, state: GrokTurnState, event: Mapping[str, Any]) -> GrokTranslation:
        kind = event.get("type")
        if kind == "available_commands":
            return GrokTranslation([])
        if kind == "usage":
            usage = event.get("usage")
            if isinstance(usage, dict):
                state.usage = usage
            return GrokTranslation(self._step_start(state))
        if kind == "text":
            return GrokTranslation([*self._step_start(state), *self._text(state, event)])
        if kind == "tool_call":
            return GrokTranslation([*self._step_start(state), *self._tool_call(state, event)])
        if kind == "tool_call_update":
            return GrokTranslation([*self._step_start(state), *self._tool_update(state, event)])
        if kind == "end":
            return self._end(state, event)
        if kind == "error":
            state.terminal = True
            detail = str(event.get("message") or "grok reported an error").strip()
            state.failure_kind, outcome = failure_outcome(detail)
            return GrokTranslation(
                [{"type": "error", "error": outcome.error, "messageId": state.message_id}],
                outcome,
            )
        # thought and anything not mapped yet.
        return GrokTranslation(self._step_start(state) if kind == "thought" else [])

    def _step_start(self, state: GrokTurnState) -> list[BridgeEvent]:
        if state.step_id is not None:
            return []
        state.step_id = str(uuid.uuid4())
        return [{"type": "step_start", "messageId": state.message_id, "stepId": state.step_id}]

    def _text(self, state: GrokTurnState, event: Mapping[str, Any]) -> list[BridgeEvent]:
        data = event.get("data")
        if not isinstance(data, str) or not data:
            return []
        if state.text_break and state.text.strip():
            state.text = state.text.rstrip() + "\n\n"
        state.text_break = False
        state.text += data
        content = state.text
        if not content.strip() or content == state.last_token_content:
            return []
        state.last_token_content = content
        return [{"type": "token", "content": content, "messageId": state.message_id}]

    def _tool_call(self, state: GrokTurnState, event: Mapping[str, Any]) -> list[BridgeEvent]:
        call_id = str(event.get("toolCallId") or uuid.uuid4())
        name, args = tool_name_and_args(event.get("toolName") or event.get("title"), event)
        state.tools[call_id] = (name, args)
        state.text_break = True
        if event.get("status") in ("completed", "failed"):
            return self._tool_update(state, event)
        return [self._tool_event(state, call_id, "running", "")]

    def _tool_update(self, state: GrokTurnState, event: Mapping[str, Any]) -> list[BridgeEvent]:
        call_id = str(event.get("toolCallId") or "")
        if not call_id or call_id in state.finished_tools:
            return []
        raw_output = event.get("rawOutput")
        if call_id not in state.tools:
            # An update for a call whose start was never seen: name it from its output.
            fallback = raw_output.get("type") if isinstance(raw_output, dict) else None
            state.tools[call_id] = (str(fallback or "tool"), {})
            state.text_break = True
        status = event.get("status")
        if status not in ("completed", "failed"):
            # null, pending and in_progress are all still running; reported once at start.
            return []
        state.finished_tools.add(call_id)
        failed = status == "failed" or _output_failed(raw_output)
        tool_status: ToolStatus = "error" if failed else "completed"
        return [self._tool_event(state, call_id, tool_status, _tool_output(event))]

    def _tool_event(
        self, state: GrokTurnState, call_id: str, status: ToolStatus, output: str
    ) -> BridgeEvent:
        name, args = state.tools[call_id]
        return {
            "type": "tool_call",
            "tool": name,
            "args": args,
            "callId": call_id,
            "status": status,
            "output": output,
            "messageId": state.message_id,
        }

    def _end(self, state: GrokTurnState, event: Mapping[str, Any]) -> GrokTranslation:
        state.terminal = True
        session_id = event.get("sessionId")
        if isinstance(session_id, str) and session_id:
            state.session_id = session_id
        stop_reason = event.get("stopReason")
        cost = event.get("total_cost_usd")
        cost_usd = (
            float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
        )
        if stop_reason != "end_turn":
            message = f"SuperGrok turn stopped early: {stop_reason or 'no stop reason'}"
            return GrokTranslation(
                [
                    *self._step_start(state),
                    {"type": "error", "error": message, "messageId": state.message_id},
                ],
                TurnOutcome.failed(message, message_cost_usd=cost_usd),
            )
        finish: BridgeEvent = {
            "type": "step_finish",
            "messageId": state.message_id,
            "stepId": state.step_id or str(uuid.uuid4()),
            "reason": "stop",
        }
        tokens = usage_tokens(event.get("usage") or state.usage)
        if tokens:
            finish["tokens"] = tokens
        if cost_usd is not None:
            finish["cost"] = cost_usd
            finish["messageCostUsd"] = cost_usd
        return GrokTranslation(
            [*self._step_start(state), finish], TurnOutcome.ok(message_cost_usd=cost_usd)
        )


def tool_name_and_args(tool_name: object, event: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The bridge name and args of a ``tool_call``; ``oi`` MCP tools get their bare names."""
    raw_input = event.get("rawInput")
    args = dict(raw_input) if isinstance(raw_input, dict) else {}
    name = str(tool_name or "tool")
    if name == MCP_CALL_TOOL and isinstance(args.get("tool_name"), str):
        server, separator, tool = args["tool_name"].partition(MCP_NAME_SEPARATOR)
        tool_input = args.get("tool_input")
        mcp_args = dict(tool_input) if isinstance(tool_input, dict) else {}
        if separator and server == OI_TOOL_SERVER_NAME:
            return tool, mcp_args
        if separator:
            return f"mcp__{server}__{tool}", mcp_args
        return args["tool_name"], mcp_args
    return TOOL_NAMES.get(name, name), args


def _output_failed(raw_output: object) -> bool:
    if not isinstance(raw_output, dict):
        return False
    exit_code = raw_output.get("exit_code")
    if isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code != 0:
        return True
    return raw_output.get("is_error") is True


def _tool_output(event: Mapping[str, Any]) -> str:
    """``rawOutput.output_for_prompt``, else the update's text content, else a raw-only output.

    ``list_dir`` sends no text content: its listing is ``rawOutput.Content.content``.
    """
    raw_output = event.get("rawOutput")
    if isinstance(raw_output, dict):
        for_prompt = raw_output.get("output_for_prompt")
        if isinstance(for_prompt, str) and for_prompt:
            return for_prompt
    texts = [
        str(block["content"].get("text") or "")
        for block in event.get("content") or []
        if isinstance(block, dict) and isinstance(block.get("content"), dict)
    ]
    joined = "\n".join(text for text in texts if text)
    if joined:
        return joined
    if isinstance(raw_output, dict) and raw_output.get("type") == "MCP":
        output = raw_output.get("output")
        return output if isinstance(output, str) else json.dumps(output)
    if isinstance(raw_output, dict) and isinstance(raw_output.get("Content"), dict):
        listing = raw_output["Content"].get("content")
        if isinstance(listing, str):
            return listing
    return ""


def usage_tokens(usage: object) -> dict[str, Any] | None:
    """grok's turn usage in the bridge's token shape."""
    if not isinstance(usage, dict):
        return None
    tokens: dict[str, Any] = {}
    for source, target in (
        ("input_tokens", "input"),
        ("output_tokens", "output"),
        ("reasoning_tokens", "reasoning"),
    ):
        value = usage.get(source)
        if isinstance(value, int):
            tokens[target] = value
    cache: dict[str, int] = {}
    for source, target in (
        ("cache_read_input_tokens", "read"),
        ("cache_creation_input_tokens", "write"),
    ):
        value = usage.get(source)
        if isinstance(value, int):
            cache[target] = value
    if cache:
        tokens["cache"] = cache
    return tokens or None
