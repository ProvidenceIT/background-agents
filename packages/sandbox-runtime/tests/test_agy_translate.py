"""AgyTranslator over recorded (and synthetic) ``agy --output-format stream-json`` lines."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sandbox_runtime.harness.agy_translate import (
    AgyTranslator,
    AgyTurnState,
    FailureKind,
    classify_failure,
    parse_event_line,
    usage_tokens,
)

FIXTURES = Path(__file__).parent / "fixtures"
CONVERSATION = "11111111-2222-4333-8444-555555555555"


def replay(name: str, **translator: Any) -> tuple[AgyTurnState, list[dict[str, Any]], Any]:
    state = AgyTurnState(message_id="msg-1")
    agy = AgyTranslator(**translator)
    events: list[dict[str, Any]] = []
    outcome = None
    for line in (FIXTURES / name).read_text().splitlines():
        event = parse_event_line(line)
        if event is None:
            continue
        translation = agy.translate(state, event)
        events.extend(translation.events)
        outcome = translation.outcome or outcome
    return state, events, outcome


def result(**fields: Any) -> dict[str, Any]:
    return {"event": "result", "result": {"conversation_id": CONVERSATION, **fields}}


def translate_one(event: dict[str, Any], **translator: Any) -> tuple[list[dict[str, Any]], Any]:
    translation = AgyTranslator(**translator).translate(AgyTurnState(message_id="m"), event)
    return translation.events, translation.outcome


class TestRecordedTurn:
    def test_records_the_conversation_and_starts_one_step(self):
        state, events, outcome = replay("agy_turn.ndjson")
        assert state.conversation_id == CONVERSATION
        assert [e["type"] for e in events].count("step_start") == 1
        assert events[0]["type"] == "step_start"
        assert outcome is not None and outcome.success

    def test_text_deltas_become_cumulative_tokens(self):
        _, events, _ = replay("agy_turn.ndjson")
        tokens = [e["content"] for e in events if e["type"] == "token"]
        assert tokens == ["READ", "README.md\nsrc", "README.md\nsrc\ntests"]

    def test_tools_run_then_complete_under_their_step_index(self):
        _, events, _ = replay("agy_turn.ndjson")
        calls = [e for e in events if e["type"] == "tool_call"]
        assert [(c["callId"], c["tool"], c["status"]) for c in calls] == [
            ("2", "bash", "running"),
            ("2", "bash", "completed"),
            ("3", "get-child-status", "running"),
            ("3", "get-child-status", "completed"),
        ]
        assert calls[0]["args"]["command"] == "ls"
        assert calls[0]["output"] == ""
        assert "README.md  src  tests" in calls[1]["output"]
        # Open Inspect's own tools show under the bare name, with their own arguments.
        assert calls[3]["args"] == {"childSessionId": "child-123"}
        assert calls[3]["output"] == "Child child-123 is running."

    def test_the_turn_finishes_with_its_usage(self):
        _, events, _ = replay("agy_turn.ndjson")
        finish = [e for e in events if e["type"] == "step_finish"]
        assert len(finish) == 1
        assert finish[0]["reason"] == "stop"
        assert finish[0]["tokens"] == {
            "input": 16180,
            "output": 66,
            "reasoning": 0,
            "cache": {"read": 0},
        }


class TestFailures:
    def test_a_non_success_result_fails_and_denied_actions_warn(self):
        state, events, outcome = replay("agy_fail.ndjson")
        assert outcome is not None and not outcome.success
        assert "model stream ended unexpectedly" in (outcome.error or "")
        assert state.failure_kind is FailureKind.OTHER
        warnings = [e for e in events if e["type"] == "warning"]
        assert len(warnings) == 1 and "denied 1 tool action" in warnings[0]["message"]
        errors = [e for e in events if e["type"] == "error"]
        assert errors and errors[0]["error"] == outcome.error
        assert not [e for e in events if e["type"] == "step_finish"]

    def test_an_auth_failure_names_the_stale_push(self):
        _, outcome = translate_one(
            result(status="ERROR", error="authentication failed or timed out"),
            stale_hint="Antigravity credential push stale since X",
        )
        assert outcome is not None and not outcome.success
        assert "refused the pushed login" in outcome.error
        assert "Antigravity credential push stale since X" in outcome.error

    def test_a_quota_failure_carries_an_unknown_window(self):
        _, outcome = translate_one(
            result(status="ERROR", error="RESOURCE_EXHAUSTED (code 429): quota exceeded")
        )
        assert outcome is not None and outcome.limit is not None
        assert outcome.limit.window == "unknown"

    def test_denied_actions_warn_on_a_successful_turn_too(self):
        events, outcome = translate_one(
            result(status="SUCCESS", response="done", denied_actions=["a", "b"])
        )
        assert outcome is not None and outcome.success
        assert any(e["type"] == "warning" and "denied 2" in e["message"] for e in events)

    def test_classification(self):
        assert classify_failure("Waiting for authentication (timeout 60s)...") is FailureKind.AUTH
        assert classify_failure("Error: authentication required. Run 'agy'") is FailureKind.AUTH
        assert classify_failure("UNAUTHENTICATED (code 401)") is FailureKind.AUTH
        assert classify_failure("rate limit reached") is FailureKind.USAGE_LIMIT
        assert classify_failure("disk full") is FailureKind.OTHER


class TestShapes:
    def test_a_result_without_streamed_text_still_yields_the_response(self):
        events, _ = translate_one(result(status="SUCCESS", response="PONG\n"))
        assert [e["content"] for e in events if e["type"] == "token"] == ["PONG"]

    def test_foreign_mcp_tools_are_qualified(self):
        events, _ = translate_one(
            {
                "event": "step_update",
                "step_update": {
                    "step_index": 7,
                    "state": "ACTIVE",
                    "step_type": "tool",
                    "tool_info": {
                        "name": "call_mcp_tool",
                        "parameters": {"ServerName": "gh", "ToolName": "search", "Arguments": {}},
                    },
                },
            }
        )
        assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["mcp__gh__search"]

    def test_user_input_and_system_messages_are_ignored(self):
        for step_type in ("user_input", "system_message"):
            events, outcome = translate_one(
                {"event": "step_update", "step_update": {"step_index": 0, "step_type": step_type}}
            )
            assert [e["type"] for e in events] == ["step_start"]
            assert outcome is None

    def test_non_json_and_unkeyed_lines_are_skipped(self):
        assert parse_event_line("warning: conversation not found") is None
        assert parse_event_line('{"type": "x"}') is None
        assert parse_event_line(b'{"event": "init"}') == {"event": "init"}

    def test_usage_without_counts_is_dropped(self):
        assert usage_tokens({}) is None
        assert usage_tokens("x") is None
