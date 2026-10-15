# ruff: noqa: RUF001  (Codex writes its messages with U+2019 apostrophes)
"""The Codex login pool: which slot an attempt runs on, its marks, and the auth link."""

import json
import os
import random
import stat
from datetime import UTC, datetime
from pathlib import Path

import pytest

from sandbox_runtime.harness import codex_pool
from sandbox_runtime.harness.claude_pool import Window
from sandbox_runtime.harness.codex_pool import (
    CONTINUE_PROMPT,
    HANDOFF_MAX_CHARS,
    MAX_EXHAUSTION_SECONDS,
    MAX_THREADS,
    FailureKind,
    LinkState,
    build_handoff_prompt,
    classify_failure,
    link_state,
    linked_slot,
    mark_auth_refused,
    mark_exhausted,
    parse_retry_at,
    pick_codex_slot,
    point_auth,
    pool_slots,
    read_state,
    record_thread_slot,
    reset_for,
    write_state,
)

# 2026-10-15T10:00:00Z, the day of the incident.
NOW = datetime(2026, 10, 15, 10, 0, tzinfo=UTC).timestamp()
INCIDENT_RESET = "2026-10-20T05:11:04Z"


def _ts(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def _home(tmp_path: Path, slots: list[str]) -> Path:
    home = tmp_path / "sf-auth"
    (home / "codex").mkdir(parents=True)
    for slot in slots:
        (home / "codex-pool" / slot).mkdir(parents=True)
        (home / "codex-pool" / slot / "auth.json").write_text(json.dumps({"slot": slot}))
    (home / "codex-pool").mkdir(exist_ok=True)
    return home


def _headroom(home: Path, readings: dict[str, tuple[int, str | None]], *, age: float = 60) -> None:
    slots = {
        slot: {"windows": [{"id": "weekly", "percentRemaining": pct, "resetsAt": resets}]}
        for slot, (pct, resets) in readings.items()
    }
    captured = datetime.fromtimestamp(NOW - age, UTC).isoformat()
    (home / "codex-pool" / "headroom.json").write_text(
        json.dumps({"capturedAt": captured, "slots": slots})
    )


def _incident(home: Path, *, age: float = 60) -> None:
    _headroom(
        home,
        {
            "codex-1": (0, INCIDENT_RESET),
            "codex-2": (88, "2026-10-21T00:00:00Z"),
            "codex-3": (100, "2026-10-22T00:00:00Z"),
        },
        age=age,
    )


def _pick(home: Path, seed: int = 0, **kwargs):
    return pick_codex_slot(home / "codex-pool", now=NOW, rng=random.Random(seed), **kwargs)


SLOTS = ["codex-1", "codex-2", "codex-3"]


class TestSlots:
    def test_slots_need_a_regular_non_empty_file_and_a_safe_name(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1", "codex-2"])
        pool = home / "codex-pool"
        (pool / "empty").mkdir()
        (pool / "empty" / "auth.json").write_text("")
        (pool / "linked").mkdir()
        (pool / "linked" / "auth.json").symlink_to(pool / "codex-1" / "auth.json")
        (pool / ".hidden").mkdir()
        (pool / ".hidden" / "auth.json").write_text("{}")
        assert list(pool_slots(pool)) == ["codex-1", "codex-2"]
        assert pool_slots(tmp_path / "missing") == {}


class TestPick:
    def test_the_incident_snapshot_never_picks_the_exhausted_account(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _incident(home)
        picks = {(_pick(home, seed).slot, _pick(home, seed).reason) for seed in range(20)}
        assert picks == {("codex-3", "ranked")}

    def test_the_exhausted_account_stays_out_on_a_stale_snapshot(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _incident(home, age=3600)
        picks = {_pick(home, seed).slot for seed in range(30)}
        assert picks == {"codex-2", "codex-3"}
        assert {_pick(home, seed).reason for seed in range(5)} == {"spread"}

    def test_no_snapshot_spreads_over_every_slot(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        assert {_pick(home, seed).slot for seed in range(40)} == set(SLOTS)

    def test_tried_slots_are_left_out(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _incident(home)
        pick = _pick(home, tried=["codex-3"])
        assert (pick.slot, pick.reason) == ("codex-2", "ranked")

    def test_force_slot_wins_even_when_exhausted_but_not_once_tried(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _incident(home)
        (home / "codex-pool" / "force-slot").write_text("codex-1\n")
        assert (_pick(home).slot, _pick(home).reason) == ("codex-1", "forced")
        assert _pick(home, tried=["codex-1"]).slot == "codex-3"
        (home / "codex-pool" / "force-slot").write_text("../etc\n")
        assert _pick(home).reason == "ranked"

    def test_a_thread_sticks_to_its_slot_while_it_has_headroom(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _incident(home)
        record_thread_slot(home / "codex-pool", "thread-a", "codex-2")
        record_thread_slot(home / "codex-pool", "thread-b", "codex-1")
        assert (
            _pick(home, thread_id="thread-a").slot,
            _pick(home, thread_id="thread-a").reason,
        ) == (
            "codex-2",
            "sticky",
        )
        # A thread whose slot is exhausted moves.
        assert _pick(home, thread_id="thread-b").slot == "codex-3"

    def test_a_low_fresh_reading_ends_stickiness(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        _headroom(home, {"codex-2": (5, None), "codex-3": (90, None)})
        record_thread_slot(home / "codex-pool", "thread-a", "codex-2")
        assert _pick(home, thread_id="thread-a").slot == "codex-3"

    def test_an_exhaustion_mark_blocks_until_its_time(self, tmp_path: Path):
        home = _home(tmp_path, SLOTS)
        pool = home / "codex-pool"
        mark_exhausted(pool, "codex-1", NOW + 600, now=NOW - 60)
        mark_exhausted(pool, "codex-2", NOW - 1, now=NOW - 3600)
        assert {_pick(home, seed).slot for seed in range(30)} == {"codex-2", "codex-3"}

    def test_a_fresh_reading_after_the_mark_clears_it(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1"])
        pool = home / "codex-pool"
        mark_exhausted(pool, "codex-1", NOW + 86400, now=NOW - 600)
        _headroom(home, {"codex-1": (90, None)}, age=60)
        assert _pick(home).reason == "ranked"
        # A reading from before the mark does not.
        _headroom(home, {"codex-1": (90, None)}, age=900)
        assert _pick(home).reason == "exhausted"

    def test_an_auth_refusal_holds_until_the_login_changes(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1", "codex-2"])
        pool = home / "codex-pool"
        mark_auth_refused(pool, "codex-1", now=NOW)
        assert {_pick(home, seed).slot for seed in range(20)} == {"codex-2"}
        auth = pool / "codex-1" / "auth.json"
        auth.write_text(json.dumps({"slot": "codex-1", "fresh": "login"}))
        os.utime(auth, ns=(1, 1))
        assert {_pick(home, seed).slot for seed in range(30)} == {"codex-1", "codex-2"}

    def test_nothing_open_uses_the_earliest_reset_first_then_gives_up(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1", "codex-2"])
        _headroom(
            home, {"codex-1": (0, "2026-10-20T05:11:04Z"), "codex-2": (2, "2026-10-16T00:00:00Z")}
        )
        pick = _pick(home)
        assert (pick.slot, pick.reason) == ("codex-2", "exhausted")
        assert _pick(home, first_attempt=False) is None
        assert _pick(home, tried=["codex-1", "codex-2"]) is None


class TestState:
    def test_state_round_trips_and_a_broken_file_reads_as_empty(self, tmp_path: Path):
        pool = _home(tmp_path, ["codex-1"]) / "codex-pool"
        assert read_state(pool) == {"slots": {}, "threads": {}}
        mark_exhausted(pool, "codex-1", _ts(INCIDENT_RESET), now=NOW)
        state = read_state(pool)
        assert state["slots"]["codex-1"]["exhaustedUntil"] == "2026-10-20T05:11:04Z"
        assert stat.S_IMODE((pool / "state.json").stat().st_mode) == 0o640
        (pool / "state.json").write_text("{not json")
        assert read_state(pool) == {"slots": {}, "threads": {}}
        (pool / "state.json").write_text('{"slots": [], "threads": {"t": 3}}')
        assert read_state(pool) == {"slots": {}, "threads": {}}

    def test_the_thread_map_keeps_the_newest_entries(self, tmp_path: Path):
        pool = _home(tmp_path, ["codex-1"]) / "codex-pool"
        state = {"slots": {}, "threads": {f"t{i}": "codex-1" for i in range(MAX_THREADS)}}
        write_state(pool, state)
        record_thread_slot(pool, "t0", "codex-2")
        record_thread_slot(pool, "new", "codex-1")
        threads = read_state(pool)["threads"]
        assert len(threads) == MAX_THREADS
        assert "t1" not in threads
        assert threads["t0"] == "codex-2"
        assert list(threads)[-1] == "new"

    def test_state_holds_no_login(self, tmp_path: Path):
        pool = _home(tmp_path, ["codex-1"]) / "codex-pool"
        mark_auth_refused(pool, "codex-1", now=NOW)
        assert '"slot": "codex-1"' not in (pool / "state.json").read_text()
        assert "authRefused" in (pool / "state.json").read_text()


class TestLink:
    def test_the_link_is_relative_and_switches_atomically(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1", "codex-2"])
        codex, pool = home / "codex", home / "codex-pool"
        assert link_state(codex, pool) is LinkState.ABSENT
        assert point_auth(codex, pool, "codex-1") is True
        assert str((codex / "auth.json").readlink()) == "../codex-pool/codex-1/auth.json"
        assert link_state(codex, pool) is LinkState.POOL_LINK
        assert linked_slot(codex, pool) == "codex-1"
        assert point_auth(codex, pool, "codex-1") is False
        assert point_auth(codex, pool, "codex-2") is True
        assert linked_slot(codex, pool) == "codex-2"
        assert not (codex / codex_pool.LINK_TMP).exists()

    def test_a_write_through_the_link_lands_in_the_slot(self, tmp_path: Path):
        """Codex saves a refresh with open+truncate on codex/auth.json."""
        home = _home(tmp_path, ["codex-1", "codex-2"])
        codex, pool = home / "codex", home / "codex-pool"
        point_auth(codex, pool, "codex-2")
        fd = os.open(codex / "auth.json", os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write('{"refreshed": true}')
        assert (pool / "codex-2" / "auth.json").read_text() == '{"refreshed": true}'
        assert (codex / "auth.json").is_symlink()
        assert json.loads((pool / "codex-1" / "auth.json").read_text()) == {"slot": "codex-1"}

    def test_a_legacy_file_is_never_replaced(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1"])
        codex, pool = home / "codex", home / "codex-pool"
        (codex / "auth.json").write_text('{"legacy": true}')
        assert link_state(codex, pool) is LinkState.LEGACY_FILE
        with pytest.raises(FileExistsError):
            point_auth(codex, pool, "codex-1")
        assert (codex / "auth.json").read_text() == '{"legacy": true}'

    def test_a_link_elsewhere_is_foreign(self, tmp_path: Path):
        home = _home(tmp_path, ["codex-1"])
        codex, pool = home / "codex", home / "codex-pool"
        (codex / "auth.json").symlink_to(tmp_path / "elsewhere.json")
        assert link_state(codex, pool) is LinkState.FOREIGN_LINK
        assert linked_slot(codex, pool) is None

    def test_a_bad_slot_name_is_refused(self, tmp_path: Path):
        home = _home(tmp_path, [])
        with pytest.raises(ValueError):
            point_auth(home / "codex", home / "codex-pool", "../x")


# Every usage-limit Display string of codex-rs protocol/src/error.rs (rust-v0.162.0).
USAGE_LIMIT_TEXTS = [
    "You’ve hit your usage limit for gpt-6-sol. Switch to another model now, or try again at 5:11 AM.",
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
    "You’ve hit your usage limit. Try the promo, or try again later.",
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 20th, 2026 5:11 AM.",
    "You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.",
    "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again later.",
    "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 20th, 2026 5:11 AM.",
    "You've hit your usage limit. Try again at 5:11 AM.",
    "You’ve hit your usage limit. Try again later.",
    "Quota exceeded. Check your plan and billing details.",
    "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    "unexpected status 429: usage_limit_reached",
]


class TestClassify:
    @pytest.mark.parametrize("text", USAGE_LIMIT_TEXTS)
    def test_every_usage_limit_variant(self, text: str):
        assert classify_failure(text) is FailureKind.USAGE_LIMIT

    @pytest.mark.parametrize(
        "text",
        [
            "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
            "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
            "unexpected status 401 Unauthorized",
            "Not logged in",
            "refresh_token_reused",
        ],
    )
    def test_refused_logins(self, text: str):
        assert classify_failure(text) is FailureKind.AUTH_REFUSED

    @pytest.mark.parametrize(
        "text",
        [
            "invalid_encrypted_content: The encrypted content could not be verified.",
            "organization_id did not match the target",
        ],
    )
    def test_threads_of_another_account(self, text: str):
        assert classify_failure(text) is FailureKind.FOREIGN_THREAD

    @pytest.mark.parametrize(
        "text",
        [
            "",
            None,
            "Selected model is at capacity. Please try a different model.",
            "stream disconnected",
        ],
    )
    def test_everything_else(self, text: str | None):
        assert classify_failure(text) is FailureKind.OTHER


class TestRetryAt:
    def test_the_dated_form(self):
        text = "visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 20th, 2026 5:11 AM."
        assert parse_retry_at(text, NOW) == _ts("2026-10-20T05:11:00Z")
        assert parse_retry_at("Try again at Nov 1st, 2026 12:05 PM.", NOW) == _ts(
            "2026-11-01T12:05:00Z"
        )
        assert parse_retry_at("Try again at Nov 2nd, 2026 12:30 AM.", NOW) == _ts(
            "2026-11-02T00:30:00Z"
        )

    def test_the_same_day_form_rolls_to_tomorrow_once_past(self):
        assert parse_retry_at("Try again at 11:30 AM.", NOW) == _ts("2026-10-15T11:30:00Z")
        assert parse_retry_at("Try again at 5:11 AM.", NOW) == _ts("2026-10-16T05:11:00Z")
        assert parse_retry_at("or try again at 9:05 PM.", NOW) == _ts("2026-10-15T21:05:00Z")

    def test_no_time(self):
        assert parse_retry_at("Try again later.", NOW) is None
        assert parse_retry_at("try again at Foo 99th, 2026 5:11 AM", NOW) is None

    def test_reset_for_prefers_the_snapshot_then_the_text_then_a_default(self):
        exhausted = [Window("weekly", 0, _ts(INCIDENT_RESET))]
        text = "You’ve hit your usage limit. Try again at Oct 18th, 2026 1:00 AM."
        assert reset_for(text, exhausted, NOW) == _ts(INCIDENT_RESET)
        assert reset_for(text, [Window("weekly", 50, _ts(INCIDENT_RESET))], NOW) == _ts(
            "2026-10-18T01:00:00Z"
        )
        assert reset_for("You’ve hit your usage limit.", [], NOW) == NOW + 1800
        assert reset_for("usage_not_included", [], NOW) == NOW + 86400
        far = "You’ve hit your usage limit. Try again at Oct 1st, 2027 1:00 AM."
        assert reset_for(far, [], NOW) == NOW + MAX_EXHAUSTION_SECONDS


class TestHandoff:
    def _rollout(self, tmp_path: Path, records: list[dict]) -> Path:
        path = tmp_path / "rollout.jsonl"
        path.write_text("\n".join(json.dumps(r) for r in records) + "\nnot json\n")
        return path

    def test_keeps_messages_and_tool_calls_but_no_reasoning(self, tmp_path: Path):
        def item(payload: dict) -> dict:
            return {"timestamp": "t", "type": "response_item", "payload": payload}

        rollout = self._rollout(
            tmp_path,
            [
                {"type": "session_meta", "payload": {"id": "x"}},
                item(
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": "<environment_context>cwd</environment_context>",
                            }
                        ],
                    }
                ),
                item(
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Add tests"}],
                    }
                ),
                item(
                    {
                        "type": "reasoning",
                        "summary": [{"text": "secret plan"}],
                        "encrypted_content": "gAAA",
                    }
                ),
                item({"type": "function_call", "name": "shell", "arguments": '{"command":["ls"]}'}),
                item(
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Done half"}],
                    }
                ),
                item({"type": "compaction", "encrypted_content": "gBBB"}),
                item(
                    {
                        "type": "message",
                        "role": "developer",
                        "content": [{"type": "input_text", "text": "rules"}],
                    }
                ),
            ],
        )
        prompt = build_handoff_prompt(rollout, "Next step")
        assert "user: Add tests" in prompt
        assert 'tool call: shell {"command":["ls"]}' in prompt
        assert "assistant: Done half" in prompt
        assert str(rollout) in prompt
        assert prompt.endswith("Next step")
        for absent in ("secret plan", "gAAA", "gBBB", "environment_context", "rules"):
            assert absent not in prompt

    def test_keeps_only_the_newest_characters(self, tmp_path: Path):
        records = [
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": f"message {i} " + "x" * 1000}],
                },
            }
            for i in range(100)
        ]
        prompt = build_handoff_prompt(self._rollout(tmp_path, records), "go")
        assert "message 99" in prompt
        assert "message 0 " not in prompt
        assert len(prompt) < HANDOFF_MAX_CHARS + 1000

    def test_a_missing_rollout_still_carries_the_prompt(self):
        prompt = build_handoff_prompt(None, "go")
        assert prompt.endswith("go")
        assert "no readable messages" in prompt

    def test_continue_prompt_says_not_to_redo(self):
        assert "do not redo completed steps" in CONTINUE_PROMPT
