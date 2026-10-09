"""``codex exec --json`` events in the bridge's event model.

Codex prints one JSON object per line (codex-cli 0.162):

- ``thread.started {thread_id}``: the conversation id ``codex exec resume`` takes;
- ``turn.started`` / ``turn.completed {usage}`` / ``turn.failed {error}``;
- ``item.started|updated|completed {item}`` where ``item.type`` is one of
  ``agent_message``, ``reasoning``, ``command_execution``, ``file_change``,
  ``mcp_tool_call``, ``web_search``, ``todo_list``, ``error`` (others are
  ignored until they are mapped);
- ``error {message}``: a transport retry ("Reconnecting... 2/5"), not the end
  of the turn; ``turn.failed`` is.

The translator keeps per-turn state only. Like the Claude translator, a
``token`` event carries the turn's whole text so far, and a tool call is
reported ``running`` when its item starts and ``completed``/``error`` when it
completes, under the item's id as ``callId``.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final, Literal

from .base import BridgeEvent, TurnOutcome
from .codex_env import RELOGIN_HINT

if TYPE_CHECKING:
    from collections.abc import Mapping

# The MCP server the harness registers for Open Inspect's own tools; its
# calls are shown under the bare tool name, as OpenCode and Claude show them.
OI_TOOL_SERVER_NAME: Final = "oi"
AUTH_FAILURE_MARKERS: Final = ("401 Unauthorized", "refresh_token", "Not logged in")

ToolStatus = Literal["running", "completed", "error"]


@dataclass
class CodexTurnState:
    """What one turn has produced so far."""

    message_id: str
    step_id: str | None = None
    thread_id: str | None = None
    # agent_message text by item id, in arrival order.
    texts: dict[str, str] = field(default_factory=dict)
    last_token_content: str | None = None
    terminal: bool = False

    def turn_text(self) -> str:
        return "\n\n".join(text for text in self.texts.values() if text)


@dataclass(frozen=True)
class CodexTranslation:
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


def turn_failure_message(detail: str) -> str:
    """The user-facing failure, with the re-login hint when Codex was refused."""
    if any(marker in detail for marker in AUTH_FAILURE_MARKERS):
        return f"Codex was refused by OpenAI: {detail}. The home's login may have expired: {RELOGIN_HINT}."
    return f"Codex turn failed: {detail}"


class CodexTranslator:
    """Stateless across turns; all state lives in ``CodexTurnState``."""

    def translate(self, state: CodexTurnState, event: Mapping[str, Any]) -> CodexTranslation:
        kind = event.get("type")
        if kind == "thread.started":
            thread_id = event.get("thread_id")
            if isinstance(thread_id, str) and thread_id:
                state.thread_id = thread_id
            return CodexTranslation([])
        if kind == "turn.started":
            return CodexTranslation(self._step_start(state))
        if kind in ("item.started", "item.updated", "item.completed"):
            item = event.get("item")
            if not isinstance(item, dict):
                return CodexTranslation([])
            return CodexTranslation([*self._step_start(state), *self._item(state, kind, item)])
        if kind == "error":
            message = str(event.get("message") or "Codex reported an error")
            return CodexTranslation([{"type": "warning", "scope": "provider", "message": message}])
        if kind == "turn.completed":
            state.terminal = True
            finish: BridgeEvent = {
                "type": "step_finish",
                "messageId": state.message_id,
                "stepId": state.step_id or str(uuid.uuid4()),
                "reason": "stop",
            }
            tokens = usage_tokens(event.get("usage"))
            if tokens:
                finish["tokens"] = tokens
            return CodexTranslation([*self._step_start(state), finish], TurnOutcome.ok())
        if kind == "turn.failed":
            state.terminal = True
            error = event.get("error")
            detail = (
                str(error.get("message") or "unknown error")
                if isinstance(error, dict)
                else str(error or "unknown error")
            )
            message = turn_failure_message(detail)
            return CodexTranslation(
                [{"type": "error", "error": message, "messageId": state.message_id}],
                TurnOutcome.failed(message),
            )
        return CodexTranslation([])

    def _step_start(self, state: CodexTurnState) -> list[BridgeEvent]:
        if state.step_id is not None:
            return []
        state.step_id = str(uuid.uuid4())
        return [{"type": "step_start", "messageId": state.message_id, "stepId": state.step_id}]

    def _item(self, state: CodexTurnState, kind: str, item: Mapping[str, Any]) -> list[BridgeEvent]:
        item_type = item.get("type")
        item_id = str(item.get("id") or uuid.uuid4())
        completed = kind == "item.completed"
        if item_type == "agent_message":
            text = item.get("text")
            if not isinstance(text, str):
                return []
            state.texts[item_id] = text
            content = state.turn_text()
            if not content or content == state.last_token_content:
                return []
            state.last_token_content = content
            return [{"type": "token", "content": content, "messageId": state.message_id}]
        if item_type == "error":
            if not completed:
                return []
            message = str(item.get("message") or "Codex reported an error")
            return [{"type": "warning", "scope": "provider", "message": message}]
        tool = _tool_call(item_type, item)
        if tool is None:
            return []
        name, args, output, failed = tool
        status: ToolStatus = ("error" if failed else "completed") if completed else "running"
        return [
            {
                "type": "tool_call",
                "tool": name,
                "args": args,
                "callId": item_id,
                "status": status,
                "output": output if completed else "",
                "messageId": state.message_id,
            }
        ]


def _tool_call(
    item_type: object, item: Mapping[str, Any]
) -> tuple[str, dict[str, Any], str, bool] | None:
    """``(tool, args, output, failed)`` for an item that is a tool call, else ``None``."""
    status = item.get("status")
    failed = status in ("failed", "declined")
    if item_type == "command_execution":
        exit_code = item.get("exit_code")
        return (
            "bash",
            {"command": str(item.get("command") or "")},
            str(item.get("aggregated_output") or ""),
            failed or (isinstance(exit_code, int) and exit_code != 0),
        )
    if item_type == "file_change":
        changes = [
            {"path": str(change.get("path") or ""), "kind": str(change.get("kind") or "")}
            for change in item.get("changes") or []
            if isinstance(change, dict)
        ]
        output = "\n".join(f"{change['kind']} {change['path']}" for change in changes)
        return "apply_patch", {"changes": changes}, output, failed
    if item_type == "mcp_tool_call":
        server = str(item.get("server") or "")
        tool = str(item.get("tool") or "tool")
        name = tool if server == OI_TOOL_SERVER_NAME else f"mcp__{server}__{tool}"
        arguments = item.get("arguments")
        error = item.get("error")
        if isinstance(error, dict) and error.get("message"):
            return name, _record(arguments), str(error["message"]), True
        return name, _record(arguments), _mcp_result_text(item.get("result")), failed
    if item_type == "web_search":
        return "web_search", {"query": str(item.get("query") or "")}, "", failed
    if item_type == "todo_list":
        todos = [entry for entry in item.get("items") or [] if isinstance(entry, dict)]
        return "todowrite", {"todos": todos}, "", failed
    return None


def _record(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"input": value}
        return parsed if isinstance(parsed, dict) else {"input": parsed}
    return {}


def _mcp_result_text(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    parts = [
        str(block.get("text") or "")
        for block in result.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "\n".join(part for part in parts if part)


def usage_tokens(usage: object) -> dict[str, Any] | None:
    """Codex's turn usage in the bridge's token shape."""
    if not isinstance(usage, dict):
        return None
    tokens: dict[str, Any] = {}
    for source, target in (
        ("input_tokens", "input"),
        ("output_tokens", "output"),
        ("reasoning_output_tokens", "reasoning"),
    ):
        value = usage.get(source)
        if isinstance(value, int):
            tokens[target] = value
    cached = usage.get("cached_input_tokens")
    if isinstance(cached, int):
        tokens["cache"] = {"read": cached}
    return tokens or None
