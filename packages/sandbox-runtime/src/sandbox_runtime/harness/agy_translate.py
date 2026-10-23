"""``agy --output-format stream-json`` events in the bridge's event model.

agy (Antigravity CLI 1.4.5) prints one JSON object per line, keyed on ``event``:

- ``init {conversation_id, init: {model, cwd, tools, permission_mode}}``;
- ``step_update {step_update: {conversation_id, step_index, state, step_type, ...}}``
  where ``state`` is ``ACTIVE`` or ``DONE`` and ``step_type`` is one of
  ``user_input``, ``agent_response`` (``text_delta`` and, when done, ``usage``),
  ``tool`` (``tool_info {name, parameters, output}``) or ``system_message``;
- ``result {result: {conversation_id, status, response, error, usage, denied_actions}}``:
  the end of the turn, ``status`` ``SUCCESS`` or anything else.

An MCP tool is called through agy's own ``call_mcp_tool`` with
``{ServerName, ToolName, Arguments}``; Open Inspect's ``oi`` tools are shown
under their bare name, as the Codex harness shows them.

Only the success shapes were recorded. How agy reports a usage limit or a
refused login is a guess kept in ``classify_failure``, the one table to edit.

The translator keeps per-turn state only. A ``token`` event carries the
turn's whole text so far; a tool call is reported ``running`` when its step is
active and ``completed`` when it is done, under its step index as ``callId``.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Final

from .agy_env import OI_TOOL_SERVER_NAME
from .base import BridgeEvent, SubscriptionLimit, TurnOutcome

if TYPE_CHECKING:
    from collections.abc import Mapping

SUCCESS_STATUS: Final = "SUCCESS"
LOST_CONVERSATION_WARNING: Final = (
    "Antigravity lost the earlier conversation; continuing without its context"
)
# agy's tools under the names the web client already renders.
TOOL_NAMES: Final[Mapping[str, str]] = {
    "run_command": "bash",
    "view_file": "read",
    "read_file": "read",
    "write_to_file": "write",
    "replace_file_content": "edit",
    "multi_replace_file_content": "edit",
    "sed_file": "edit",
    "list_dir": "list",
    "grep_search": "grep",
    "find_by_name": "glob",
    "search_web": "web_search",
    "read_url_content": "webfetch",
}
MCP_TOOL: Final = "call_mcp_tool"


class FailureKind(StrEnum):
    AUTH = "auth"
    USAGE_LIMIT = "usage_limit"
    OTHER = "other"


# Lowercased substrings, checked in order. Auth ones were seen live (an
# expired or missing token, a token Google refused); the limit ones are guesses.
_FAILURE_MARKERS: Final[tuple[tuple[str, FailureKind], ...]] = (
    ("authentication failed or timed out", FailureKind.AUTH),
    ("authentication required", FailureKind.AUTH),
    ("waiting for authentication", FailureKind.AUTH),
    ("you are not logged into", FailureKind.AUTH),
    ("unauthenticated", FailureKind.AUTH),
    ("resource_exhausted", FailureKind.USAGE_LIMIT),
    ("resource exhausted", FailureKind.USAGE_LIMIT),
    ("quota", FailureKind.USAGE_LIMIT),
    ("rate limit", FailureKind.USAGE_LIMIT),
    ("code 429", FailureKind.USAGE_LIMIT),
)


def classify_failure(detail: str) -> FailureKind:
    text = detail.lower()
    for marker, kind in _FAILURE_MARKERS:
        if marker in text:
            return kind
    return FailureKind.OTHER


@dataclass
class AgyTurnState:
    """What one turn has produced so far."""

    message_id: str
    step_id: str | None = None
    conversation_id: str | None = None
    # agent_response text by step index, in arrival order.
    texts: dict[int, str] = field(default_factory=dict)
    last_token_content: str | None = None
    terminal: bool = False
    failure_kind: FailureKind | None = None

    def turn_text(self) -> str:
        return "\n\n".join(text.strip("\n") for text in self.texts.values() if text.strip())


@dataclass(frozen=True)
class AgyTranslation:
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
    return parsed if isinstance(parsed, dict) and isinstance(parsed.get("event"), str) else None


def failure_outcome(detail: str, *, stale_hint: str | None = None) -> TurnOutcome:
    """The failed outcome for ``detail``: a usage limit carries its window, auth the hint."""
    kind = classify_failure(detail)
    if kind is FailureKind.AUTH:
        hint = f" {stale_hint}." if stale_hint else ""
        return TurnOutcome.failed(f"Antigravity refused the pushed login: {detail}.{hint}")
    if kind is FailureKind.USAGE_LIMIT:
        return TurnOutcome.failed(
            f"Antigravity usage limit: {detail}", limit=SubscriptionLimit.of("unknown")
        )
    return TurnOutcome.failed(f"Antigravity turn failed: {detail}")


class AgyTranslator:
    """Stateless across turns; all state lives in ``AgyTurnState``."""

    def __init__(self, *, stale_hint: str | None = None) -> None:
        # Named in an auth failure: why the pushed token may be dead.
        self.stale_hint = stale_hint

    def translate(self, state: AgyTurnState, event: Mapping[str, Any]) -> AgyTranslation:
        kind = event.get("event")
        if kind == "init":
            self._record_conversation(state, event.get("conversation_id"))
            return AgyTranslation(self._step_start(state))
        if kind == "step_update":
            step = event.get("step_update")
            if not isinstance(step, dict):
                return AgyTranslation([])
            self._record_conversation(state, step.get("conversation_id"))
            return AgyTranslation([*self._step_start(state), *self._step(state, step)])
        if kind == "result":
            result = event.get("result")
            return self._result(state, result if isinstance(result, dict) else {})
        return AgyTranslation([])

    def _record_conversation(self, state: AgyTurnState, value: object) -> None:
        if isinstance(value, str) and value and state.conversation_id is None:
            state.conversation_id = value

    def _step_start(self, state: AgyTurnState) -> list[BridgeEvent]:
        if state.step_id is not None:
            return []
        state.step_id = str(uuid.uuid4())
        return [{"type": "step_start", "messageId": state.message_id, "stepId": state.step_id}]

    def _step(self, state: AgyTurnState, step: Mapping[str, Any]) -> list[BridgeEvent]:
        step_type = step.get("step_type")
        index = step.get("step_index")
        key = index if isinstance(index, int) else len(state.texts)
        if step_type == "agent_response":
            delta = step.get("text_delta")
            if not isinstance(delta, str) or not delta:
                return []
            state.texts[key] = state.texts.get(key, "") + delta
            content = state.turn_text()
            if not content or content == state.last_token_content:
                return []
            state.last_token_content = content
            return [{"type": "token", "content": content, "messageId": state.message_id}]
        if step_type == "tool":
            info = step.get("tool_info")
            info = info if isinstance(info, dict) else {}
            name, args = tool_name_and_args(
                str(info.get("name") or step.get("tool_name") or ""), info
            )
            done = step.get("state") == "DONE"
            output = info.get("output")
            return [
                {
                    "type": "tool_call",
                    "tool": name,
                    "args": args,
                    "callId": str(key),
                    "status": "completed" if done else "running",
                    "output": str(output) if done and output is not None else "",
                    "messageId": state.message_id,
                }
            ]
        return []

    def _result(self, state: AgyTurnState, result: Mapping[str, Any]) -> AgyTranslation:
        state.terminal = True
        self._record_conversation(state, result.get("conversation_id"))
        events: list[BridgeEvent] = self._step_start(state)
        response = result.get("response")
        if isinstance(response, str) and response.strip() and not state.texts:
            # A turn whose text never streamed (a stdin turn agy answered in one step).
            state.texts[-1] = response
            state.last_token_content = state.turn_text()
            events.append(
                {
                    "type": "token",
                    "content": state.last_token_content,
                    "messageId": state.message_id,
                }
            )
        denied = result.get("denied_actions")
        if denied:
            events.append(
                {
                    "type": "warning",
                    "scope": "provider",
                    "message": f"Antigravity denied {_count(denied)} tool action(s) in this turn.",
                }
            )
        if result.get("status") == SUCCESS_STATUS:
            finish: BridgeEvent = {
                "type": "step_finish",
                "messageId": state.message_id,
                "stepId": state.step_id,
                "reason": "stop",
            }
            tokens = usage_tokens(result.get("usage"))
            if tokens:
                finish["tokens"] = tokens
            events.append(finish)
            return AgyTranslation(events, TurnOutcome.ok())
        detail = str(result.get("error") or result.get("status") or "unknown error")
        state.failure_kind = classify_failure(detail)
        outcome = failure_outcome(detail, stale_hint=self.stale_hint)
        assert outcome.error is not None
        events.append({"type": "error", "error": outcome.error, "messageId": state.message_id})
        return AgyTranslation(events, outcome)


def tool_name_and_args(name: str, info: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The bridge's tool name and arguments for one agy tool step."""
    parameters = info.get("parameters")
    args = dict(parameters) if isinstance(parameters, dict) else {}
    if name == MCP_TOOL:
        server = str(args.get("ServerName") or "")
        tool = str(args.get("ToolName") or "tool")
        arguments = args.get("Arguments")
        call_args = dict(arguments) if isinstance(arguments, dict) else {}
        return (tool if server == OI_TOOL_SERVER_NAME else f"mcp__{server}__{tool}"), call_args
    if name == "run_command" and "CommandLine" in args:
        # The web client renders a bash call's ``command``.
        args = {"command": str(args["CommandLine"]), **args}
    return TOOL_NAMES.get(name, name or "tool"), args


def _count(denied: object) -> int:
    return len(denied) if isinstance(denied, (list, dict)) else 1


def usage_tokens(usage: object) -> dict[str, Any] | None:
    """agy's turn usage in the bridge's token shape."""
    if not isinstance(usage, dict):
        return None
    tokens: dict[str, Any] = {}
    for source, target in (
        ("input_tokens", "input"),
        ("output_tokens", "output"),
        ("thinking_tokens", "reasoning"),
    ):
        value = usage.get(source)
        if isinstance(value, int):
            tokens[target] = value
    cached = usage.get("cache_read_tokens")
    if isinstance(cached, int):
        tokens["cache"] = {"read": cached}
    return tokens or None
