"""GrokTranslator over recorded (scrubbed) ``grok -p --output-format streaming-json`` turns."""

from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

import pytest

from sandbox_runtime.harness.grok_translate import (
    FailureKind,
    GrokTranslator,
    GrokTurnState,
    classify_failure,
    failure_outcome,
    parse_event_line,
    tool_name_and_args,
    usage_tokens,
)

FIXTURES = Path(__file__).parent / "fixtures"


def replay(name: str) -> tuple[GrokTurnState, list[dict[str, Any]], list[Any]]:
    state = GrokTurnState(message_id="msg-1")
    translator = GrokTranslator()
    events: list[dict[str, Any]] = []
    outcomes: list[Any] = []
    for line in (FIXTURES / name).read_text().splitlines():
        event = parse_event_line(
            line.replace("@SESSION_ID@", "11111111-1111-4111-8111-111111111111")
        )
        assert event is not None
        translation = translator.translate(state, event)
        events.extend(translation.events)
        if translation.outcome is not None:
            outcomes.append(translation.outcome)
    return state, events, outcomes


def test_pong_turn_is_cumulative_text_and_ok_with_cost() -> None:
    state, events, outcomes = replay("grok_turn.ndjson")
    assert [event["type"] for event in events] == ["step_start", "token", "token", "step_finish"]
    assert [event["content"] for event in events if event["type"] == "token"] == ["PO", "PONG"]
    [outcome] = outcomes
    assert outcome.success
    assert outcome.message_cost_usd == pytest.approx(0.02184296)
    finish = events[-1]
    assert finish["reason"] == "stop"
    assert finish["stepId"] == events[0]["stepId"]
    assert finish["tokens"] == {
        "input": 13089,
        "output": 12,
        "reasoning": 9,
        "cache": {"read": 10112, "write": 0},
    }
    assert state.session_id == "11111111-1111-4111-8111-111111111111"


def test_tool_turn_runs_then_completes_and_names_oi_tools_bare() -> None:
    _, events, outcomes = replay("grok_tool_turn.ndjson")
    tools = [event for event in events if event["type"] == "tool_call"]
    assert [(t["tool"], t["status"]) for t in tools] == [
        ("bash", "running"),
        ("bash", "completed"),
        ("memory_read", "running"),
        ("memory_read", "error"),
    ]
    bash_done = tools[1]
    assert bash_done["args"]["command"] == "ls"
    assert bash_done["output"].startswith("exit: 0\na.txt")
    assert bash_done["callId"] == tools[0]["callId"]
    oi_failed = tools[3]
    assert oi_failed["args"] == {"memoryId": "probe"}
    assert "memory_read failed" in oi_failed["output"]
    tokens = [event["content"] for event in events if event["type"] == "token"]
    # Each token carries the turn's whole text so far.
    assert all(later.startswith(earlier) for earlier, later in itertools.pairwise(tokens))
    assert tokens[-1].startswith("a.txt\n")
    assert outcomes[0].success


def test_text_after_a_tool_starts_a_new_paragraph() -> None:
    state = GrokTurnState(message_id="m")
    translator = GrokTranslator()
    translator.translate(state, {"type": "text", "data": "Looking."})
    translator.translate(
        state,
        {"type": "tool_call", "toolCallId": "c1", "toolName": "read_file", "rawInput": {}},
    )
    [token] = translator.translate(state, {"type": "text", "data": "Found it."}).events
    assert token["content"] == "Looking.\n\nFound it."


def test_nonzero_exit_code_is_an_error() -> None:
    state = GrokTurnState(message_id="m")
    translator = GrokTranslator()
    translator.translate(
        state,
        {
            "type": "tool_call",
            "toolCallId": "c1",
            "toolName": "run_terminal_command",
            "rawInput": {"command": "false"},
            "status": "pending",
        },
    )
    in_progress = translator.translate(
        state,
        {"type": "tool_call_update", "toolCallId": "c1", "status": "in_progress", "rawOutput": {}},
    )
    assert in_progress.events == []
    [done] = translator.translate(
        state,
        {
            "type": "tool_call_update",
            "toolCallId": "c1",
            "status": "completed",
            "rawOutput": {"type": "Bash", "exit_code": 1, "output_for_prompt": "exit: 1\n"},
        },
    ).events
    assert (done["tool"], done["status"], done["output"]) == ("bash", "error", "exit: 1\n")
    # A repeated final update is not reported twice.
    again = translator.translate(
        state, {"type": "tool_call_update", "toolCallId": "c1", "status": "completed"}
    )
    assert again.events == []


def test_list_dir_output_is_its_raw_listing() -> None:
    # Recorded from grok 1.0.52: list_dir sends no text content, only rawOutput.
    state = GrokTurnState(message_id="m")
    translator = GrokTranslator()
    translator.translate(
        state,
        {
            "type": "tool_call",
            "toolCallId": "c1",
            "toolName": "list_dir",
            "rawInput": {"target_directory": "."},
            "status": "pending",
            "content": [],
        },
    )
    listing = "- /workspace/demo/\n  - a.txt\n  - b.txt"
    [done] = translator.translate(
        state,
        {
            "type": "tool_call_update",
            "toolCallId": "c1",
            "status": "completed",
            "content": [],
            "rawOutput": {
                "type": "ListDir",
                "Content": {"content": listing, "absolute_root_path": "/workspace/demo/."},
            },
        },
    ).events
    assert (done["status"], done["output"]) == ("completed", listing)


@pytest.mark.parametrize(
    ("tool_name", "raw_input", "expected"),
    [
        ("run_terminal_command", {"command": "ls"}, ("bash", {"command": "ls"})),
        ("search_replace", {"path": "a"}, ("edit", {"path": "a"})),
        ("edit_file", {"path": "a"}, ("edit", {"path": "a"})),
        ("read_file", {"path": "a"}, ("read", {"path": "a"})),
        ("list_dir", {}, ("list_dir", {})),
        (
            "use_tool",
            {"tool_name": "oi__spawn-child", "tool_input": {"prompt": "x"}},
            ("spawn-child", {"prompt": "x"}),
        ),
        (
            "use_tool",
            {"tool_name": "linear__create_issue", "tool_input": {}},
            ("mcp__linear__create_issue", {}),
        ),
    ],
)
def test_tool_names(
    tool_name: str, raw_input: dict[str, Any], expected: tuple[str, dict[str, Any]]
) -> None:
    assert tool_name_and_args(tool_name, {"rawInput": raw_input}) == expected


def test_end_with_another_stop_reason_fails() -> None:
    state = GrokTurnState(message_id="m")
    translation = GrokTranslator().translate(
        state, {"type": "end", "stopReason": "max_turns", "total_cost_usd": 0.5}
    )
    assert translation.outcome is not None
    assert not translation.outcome.success
    assert "max_turns" in (translation.outcome.error or "")
    assert translation.outcome.message_cost_usd == 0.5
    assert translation.events[-1]["type"] == "error"


def test_not_signed_in_is_an_auth_failure() -> None:
    state, events, outcomes = replay("grok_fail.ndjson")
    [outcome] = outcomes
    assert not outcome.success
    assert state.failure_kind is FailureKind.AUTH
    assert "sf-cred-push.timer" in (outcome.error or "")
    assert outcome.limit is None
    assert events[-1]["type"] == "error"


@pytest.mark.parametrize(
    ("detail", "kind"),
    [
        ("HTTP 429 Too Many Requests", FailureKind.USAGE_LIMIT),
        ("You have reached your usage limit", FailureKind.USAGE_LIMIT),
        ("rate limit exceeded", FailureKind.USAGE_LIMIT),
        ("Not signed in. To authenticate", FailureKind.AUTH),
        ("server returned 401", FailureKind.AUTH),
        ("GROK_AUTH_EXPIRED", FailureKind.AUTH),
        (
            '{"error": "SuperGrok credential push stale since 2026-10-23T00:00:00Z; check '
            'sf-cred-push.timer on pc-bram-desktop"}',
            FailureKind.AUTH,
        ),
        ("Error: Failed to restore session from remote: 404 Not Found", FailureKind.RESTORE),
        ("segfault", FailureKind.OTHER),
    ],
)
def test_classification(detail: str, kind: FailureKind) -> None:
    assert classify_failure(detail) is kind


def test_usage_limit_carries_an_unknown_window() -> None:
    kind, outcome = failure_outcome("429 Too Many Requests")
    assert kind is FailureKind.USAGE_LIMIT
    assert outcome.limit is not None
    assert outcome.limit.window == "unknown"


def test_parse_event_line_skips_noise() -> None:
    assert parse_event_line(b"not json\n") is None
    assert parse_event_line("{}") is None
    assert parse_event_line(json.dumps({"type": "text", "data": "x"})) == {
        "type": "text",
        "data": "x",
    }


def test_usage_tokens_without_usage() -> None:
    assert usage_tokens(None) is None
    assert usage_tokens({}) is None
