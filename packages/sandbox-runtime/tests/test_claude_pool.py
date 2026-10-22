"""The Claude subscription pool: which slot a child runs on, and that no token leaks."""

import json
import random
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from sandbox_runtime.auth_home import AuthHomeSecretRedactor, auth_home_boot_report
from sandbox_runtime.harness.claude_env import (
    POOL_PICK_FILE,
    POOL_REFUSALS_FILE,
    PREFERRED_SLOT_ENV_VAR,
    ClaudeAuthMode,
    auth_home_has_claude_token,
    write_clean_env_wrapper,
)
from sandbox_runtime.harness.claude_pool import (
    EXHAUSTED_PERCENT,
    FRESH_SECONDS,
    UNKNOWN_RESET_BLOCK_SECONDS,
    Window,
    model_window,
    pick_slot,
    pool_slots,
    rank_pick,
    read_refusals,
    record_refusal,
    refusal_scope,
)

NOW = 1_800_000_000.0


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat()


def _token(slot: str) -> str:
    return f"sk-ant-oat01-pool-{slot}-placeholder"


def _home(tmp_path: Path, slots: list[str], *, single: bool = False) -> Path:
    home = tmp_path / "sf-auth"
    claude = home / "claude"
    claude.mkdir(parents=True)
    if single:
        (claude / "oauth-token").write_text("sk-ant-oat01-single-placeholder\n")
    for slot in slots:
        (claude / "pool" / slot).mkdir(parents=True)
        (claude / "pool" / slot / "oauth-token").write_text(_token(slot) + "\n")
    return home


def _headroom(
    home: Path, readings: dict[str, dict[str, int | tuple[int, float | None]]], *, age: float = 60
) -> None:
    slots = {}
    for slot, windows in readings.items():
        entries = []
        for window_id, value in windows.items():
            percent, resets = value if isinstance(value, tuple) else (value, NOW + 3600)
            entry: dict[str, object] = {"id": window_id, "percentRemaining": percent}
            if resets is not None:
                entry["resetsAt"] = _iso(resets)
            entries.append(entry)
        slots[slot] = {"windows": entries}
    (home / "claude" / "pool" / "headroom.json").write_text(
        json.dumps({"capturedAt": _iso(NOW - age), "slots": slots})
    )


def _pick(home: Path, argv: list[str] | None = None, seed: int = 0):
    return pick_slot(home / "claude", argv or [], now=NOW, rng=random.Random(seed))


class TestSlots:
    def test_pool_slots_need_a_non_empty_token_and_a_safe_name(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        (home / "claude" / "pool" / "empty").mkdir()
        (home / "claude" / "pool" / "empty" / "oauth-token").write_text(" \n")
        (home / "claude" / "pool" / ".hidden").mkdir()
        (home / "claude" / "pool" / ".hidden" / "oauth-token").write_text(_token("x"))
        assert sorted(pool_slots(home / "claude")) == ["claude-1", "claude-2"]

    def test_the_single_token_is_the_default_slot_only_without_a_pool(self, tmp_path: Path) -> None:
        assert list(pool_slots(_home(tmp_path / "a", [], single=True) / "claude")) == ["default"]
        assert list(pool_slots(_home(tmp_path / "b", ["claude-1"], single=True) / "claude")) == [
            "claude-1"
        ]
        assert pick_slot(_home(tmp_path / "c", []) / "claude", []) is None

    def test_a_home_has_a_token_with_either_layout(self, tmp_path: Path) -> None:
        pool = _home(tmp_path / "pool", ["claude-1"])
        single = _home(tmp_path / "single", [], single=True)
        empty = _home(tmp_path / "empty", [])
        assert auth_home_has_claude_token(pool / "claude" / "oauth-token")
        assert auth_home_has_claude_token(single / "claude" / "oauth-token")
        assert not auth_home_has_claude_token(empty / "claude" / "oauth-token")

    def test_the_model_window_comes_from_the_model_argument(self) -> None:
        assert model_window(["--model", "claude-fable-5-1"]) == "fable"
        assert model_window(["--model=claude-opus-5-5"]) == "opus"
        assert model_window(["--model", "sonnet"]) == "sonnet"
        assert model_window(["-p", "hi"]) is None


class TestPick:
    def test_a_fresh_snapshot_picks_the_most_headroom(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": 90, "seven_day": 20},
                "claude-2": {"five_hour": 70, "seven_day": 80},
                "claude-3": {"five_hour": 100, "seven_day": 40},
            },
        )
        pick = _pick(home)
        assert (pick.slot, pick.reason, pick.percent_remaining) == ("claude-2", "ranked", 70)
        assert pick.token_file == home / "claude" / "pool" / "claude-2" / "oauth-token"

    def test_near_equal_slots_share_the_load(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": 95, "seven_day": 90},
                "claude-2": {"five_hour": 88, "seven_day": 99},
                "claude-3": {"five_hour": 30, "seven_day": 99},
            },
        )
        chosen = {_pick(home, seed=seed).slot for seed in range(40)}
        assert chosen == {"claude-1", "claude-2"}

    def test_the_model_window_bounds_the_choice(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": 100, "seven_day": 100, "fable": 10},
                "claude-2": {"five_hour": 60, "seven_day": 60, "fable": 60},
            },
        )
        assert _pick(home, ["--model", "claude-fable-5-1"]).slot == "claude-2"
        assert _pick(home, ["--model", "claude-opus-5-5"]).slot == "claude-1"

    def test_an_exhausted_window_rules_a_slot_out_until_its_reset(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": 100, "seven_day": (0, NOW + 86_400)},
                "claude-2": {"five_hour": 20, "seven_day": 30},
            },
            # Stale: no ranking, but the exhaustion still holds.
            age=FRESH_SECONDS + 1,
        )
        picks = {_pick(home, seed=seed).slot for seed in range(20)}
        assert picks == {"claude-2"}
        assert _pick(home).reason == "spread"

    def test_an_exhaustion_whose_reset_passed_no_longer_counts(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1"])
        _headroom(
            home, {"claude-1": {"five_hour": (0, NOW - 1), "seven_day": 50}}, age=FRESH_SECONDS + 1
        )
        assert _pick(home).reason == "spread"

    def test_a_stale_snapshot_spreads_over_every_open_slot(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        _headroom(
            home,
            {"claude-1": {"five_hour": 100, "seven_day": 100}},
            age=FRESH_SECONDS + 1,
        )
        picks = {_pick(home, seed=seed) for seed in range(60)}
        assert {pick.slot for pick in picks} == {"claude-1", "claude-2", "claude-3"}
        assert {pick.reason for pick in picks} == {"spread"}
        assert {pick.percent_remaining for pick in picks} == {None}

    def test_no_snapshot_or_a_broken_one_spreads(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        assert _pick(home).reason == "spread"
        (home / "claude" / "pool" / "headroom.json").write_text("{not json")
        assert _pick(home).reason == "spread"
        (home / "claude" / "pool" / "headroom.json").write_text(
            json.dumps({"capturedAt": _iso(NOW), "slots": {"claude-1": {"windows": [{"id": 1}]}}})
        )
        assert _pick(home).reason == "spread"

    def test_a_snapshot_from_the_future_is_not_fresh(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(home, {"claude-1": {"five_hour": 90, "seven_day": 90}}, age=-600)
        assert _pick(home).reason == "spread"

    def test_slots_without_a_fresh_reading_are_used_before_low_ones(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {"claude-1": {"five_hour": EXHAUSTED_PERCENT, "seven_day": 50}},
        )
        # claude-1's 5h window is exhausted until its reset; claude-2 has no reading.
        assert _pick(home).slot == "claude-2"

    def test_when_every_slot_is_exhausted_the_earliest_reset_is_used(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": (0, NOW + 7200), "seven_day": 50},
                "claude-2": {"five_hour": (2, NOW + 600), "seven_day": 50},
            },
        )
        pick = _pick(home)
        assert (pick.slot, pick.reason, pick.percent_remaining) == ("claude-2", "exhausted", 0)


class TestRankPick:
    """The ranking core the Codex pool shares (``account_windows=None``: any window id)."""

    def test_any_window_ranks_when_no_account_windows_are_named(self) -> None:
        readings = {
            "codex-1": [Window("weekly", 0, NOW + 3600)],
            "codex-2": [Window("weekly", 88, NOW + 86400)],
            "codex-3": [Window("weekly", 100, NOW + 86400)],
        }
        picks = {
            rank_pick(
                ["codex-1", "codex-2", "codex-3"],
                readings,
                NOW - 60,
                account_windows=None,
                now=NOW,
                rng=random.Random(seed),
            )
            for seed in range(20)
        }
        # 88 is more than SPREAD_PERCENT below 100, so only codex-3 is near the best.
        assert {(p.slot, p.reason) for p in picks if p} == {("codex-3", "ranked")}

    def test_named_account_windows_ignore_a_weekly_only_reading(self) -> None:
        ranked = rank_pick(
            ["a"],
            {"a": [Window("weekly", 50, None)]},
            NOW,
            account_windows=("five_hour",),
            now=NOW,
            rng=random.Random(0),
        )
        assert ranked is not None and ranked.reason == "spread"

    def test_blocked_until_rules_a_slot_out_and_falls_back_to_the_earliest(self) -> None:
        args = {"account_windows": None, "now": NOW, "rng": random.Random(0)}
        ranked = rank_pick(["a", "b"], {}, None, blocked_until={"a": NOW + 60}, **args)
        assert ranked is not None and ranked.slot == "b"
        ranked = rank_pick(
            ["a", "b"], {}, None, blocked_until={"a": NOW + 60, "b": NOW + 30}, **args
        )
        assert ranked is not None and (ranked.slot, ranked.reason) == ("b", "exhausted")
        assert rank_pick([], {}, None, **args) is None

    def test_a_refused_slot_is_passed_over_until_its_reset(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-5"])
        refusals = tmp_path / "refused.json"
        record_refusal(refusals, "claude-5", NOW + 600, NOW)
        picks = {
            pick_slot(
                home / "claude", [], refusals_file=refusals, now=NOW, rng=random.Random(seed)
            ).slot
            for seed in range(20)
        }
        assert picks == {"claude-1"}
        later = {
            pick_slot(
                home / "claude", [], refusals_file=refusals, now=NOW + 601, rng=random.Random(s)
            ).slot
            for s in range(20)
        }
        assert later == {"claude-1", "claude-5"}

    def test_refusals_merge_and_one_without_a_reset_lasts_the_default(self, tmp_path: Path) -> None:
        refusals = tmp_path / "refused.json"
        record_refusal(refusals, "claude-1", NOW + 600, NOW)
        record_refusal(refusals, "claude-2", None, NOW)
        record_refusal(refusals, "claude-3", NOW - 1, NOW)
        assert read_refusals(refusals, NOW) == {
            "claude-1": NOW + 600,
            "claude-2": NOW + UNKNOWN_RESET_BLOCK_SECONDS,
            "claude-3": NOW + UNKNOWN_RESET_BLOCK_SECONDS,
        }
        assert read_refusals(refusals, NOW + 700) == {
            "claude-2": NOW + UNKNOWN_RESET_BLOCK_SECONDS,
            "claude-3": NOW + UNKNOWN_RESET_BLOCK_SECONDS,
        }
        refusals.write_text("not json")
        assert read_refusals(refusals, NOW) == {}

    def test_a_model_window_refusal_blocks_only_that_model(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-5"])
        refusals = tmp_path / "refused.json"
        record_refusal(refusals, "claude-5", NOW + 6 * 86400, NOW, scope="opus")
        assert read_refusals(refusals, NOW) == {}
        assert read_refusals(refusals, NOW, ["opus"]) == {"claude-5": NOW + 6 * 86400}

        def picks(model: str) -> set[str]:
            return {
                pick_slot(
                    home / "claude",
                    ["--model", model],
                    refusals_file=refusals,
                    now=NOW,
                    rng=random.Random(seed),
                ).slot
                for seed in range(20)
            }

        assert picks("claude-opus-4-6") == {"claude-1"}
        assert picks("claude-sonnet-4-6") == {"claude-1", "claude-5"}

    def test_refusal_scopes_follow_the_limit_window(self) -> None:
        assert refusal_scope("seven_day_opus") == "opus"
        assert refusal_scope("seven_day_sonnet") == "sonnet"
        assert refusal_scope("five_hour") == "account"
        assert refusal_scope("seven_day") == "account"
        assert refusal_scope("overage") == "account"
        assert refusal_scope("unknown") == "account"

    def test_the_module_still_runs_standalone(self, tmp_path: Path) -> None:
        source = Path(__file__).parents[1] / "src/sandbox_runtime/harness/claude_pool.py"
        (tmp_path / "standalone_pool.py").write_text(source.read_text())
        subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                "import sys; sys.path.insert(0, '.'); import standalone_pool",
            ],
            cwd=tmp_path,
            check=True,
            timeout=30,
        )


def _fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "fake-claude"
    binary.write_text(
        f"#!{sys.executable}\nimport json, os, sys\n"
        'print(json.dumps({"token": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")}))\n'
    )
    binary.chmod(0o755)
    return binary


class TestPreferredSlot:
    def _pick(self, home: Path, preferred: str | None, **kwargs):
        return [
            pick_slot(
                home / "claude", [], preferred=preferred, now=NOW, rng=random.Random(seed), **kwargs
            )
            for seed in range(20)
        ]

    def test_the_preferred_slot_is_used_over_more_headroom(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        _headroom(
            home,
            {"claude-1": {"five_hour": 90}, "claude-2": {"five_hour": 30, "seven_day": 20}},
        )
        picks = self._pick(home, "claude-2")
        assert {(p.slot, p.reason, p.percent_remaining) for p in picks} == {
            ("claude-2", "preferred", 20)
        }
        assert {p.token_file for p in picks} == {
            home / "claude" / "pool" / "claude-2" / "oauth-token"
        }

    def test_a_preferred_slot_without_a_fresh_reading_reports_no_percent(
        self, tmp_path: Path
    ) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(home, {"claude-2": {"five_hour": 70}}, age=FRESH_SECONDS + 1)
        assert {(p.slot, p.reason, p.percent_remaining) for p in self._pick(home, "claude-2")} == {
            ("claude-2", "preferred", None)
        }
        _headroom(home, {"claude-1": {"five_hour": 70}})
        assert {(p.slot, p.reason, p.percent_remaining) for p in self._pick(home, "claude-2")} == {
            ("claude-2", "preferred", None)
        }

    def test_a_refused_preferred_slot_falls_back_to_the_normal_pick(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        _headroom(home, {"claude-1": {"five_hour": 90}, "claude-3": {"five_hour": 40}})
        refusals = tmp_path / "refused.json"
        record_refusal(refusals, "claude-2", NOW + 600, NOW)
        picks = self._pick(home, "claude-2", refusals_file=refusals)
        assert {(p.slot, p.reason, p.percent_remaining) for p in picks} == {
            ("claude-1", "ranked", 90)
        }
        after_reset = pick_slot(
            home / "claude", [], refusals_file=refusals, preferred="claude-2", now=NOW + 601
        )
        assert (after_reset.slot, after_reset.reason) == ("claude-2", "preferred")

    def test_a_model_refusal_drops_the_preference_only_for_that_model(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        refusals = tmp_path / "refused.json"
        record_refusal(refusals, "claude-2", NOW + 86400, NOW, scope="opus")

        def slots(model: str) -> set[str]:
            return {
                pick_slot(
                    home / "claude",
                    ["--model", model],
                    refusals_file=refusals,
                    preferred="claude-2",
                    now=NOW,
                    rng=random.Random(seed),
                ).slot
                for seed in range(20)
            }

        assert slots("claude-opus-4-6") == {"claude-1"}
        assert slots("claude-sonnet-4-6") == {"claude-2"}

    def test_an_exhausted_preferred_slot_falls_back_even_in_an_old_snapshot(
        self, tmp_path: Path
    ) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {"claude-2": {"five_hour": (EXHAUSTED_PERCENT, NOW + 900)}},
            age=FRESH_SECONDS + 1,
        )
        assert {(p.slot, p.reason) for p in self._pick(home, "claude-2")} == {
            ("claude-1", "spread")
        }

    def test_a_fresh_low_preferred_slot_without_a_reset_falls_back(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": (90, None)},
                "claude-2": {"five_hour": (EXHAUSTED_PERCENT - 3, None)},
            },
        )
        assert {(p.slot, p.reason, p.percent_remaining) for p in self._pick(home, "claude-2")} == {
            ("claude-1", "ranked", 90)
        }

    def test_when_every_slot_is_exhausted_the_preference_does_not_override(
        self, tmp_path: Path
    ) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(
            home,
            {
                "claude-1": {"five_hour": (0, NOW + 300)},
                "claude-2": {"five_hour": (0, NOW + 900)},
            },
        )
        assert {(p.slot, p.reason) for p in self._pick(home, "claude-2")} == {
            ("claude-1", "exhausted")
        }

    def test_an_unknown_or_unsafe_name_gets_the_normal_pick(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        _headroom(home, {"claude-1": {"five_hour": 90}, "claude-2": {"five_hour": 10}})
        for name in ("claude-9", "../claude-2", "", "claude-2/", "pool"):
            picks = self._pick(home, name)
            assert {(p.slot, p.reason) for p in picks} == {("claude-1", "ranked")}, name

    def test_a_single_token_home_ignores_a_pool_slot_preference(self, tmp_path: Path) -> None:
        home = _home(tmp_path, [], single=True)
        assert {(p.slot, p.reason) for p in self._pick(home, "claude-2")} == {("default", "spread")}


class TestWrapper:
    def _run(
        self, tmp_path: Path, home: Path, *args: str, env: dict[str, str] | None = None
    ) -> tuple[dict, Path]:
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin",
            mode=ClaudeAuthMode.AUTH_HOME,
            binary=_fake_binary(tmp_path),
            token_file=home / "claude" / "oauth-token",
        )
        config = tmp_path / "cfg"
        config.mkdir(exist_ok=True)
        completed = subprocess.run(
            [str(wrapper), *args],
            env={"PATH": "/usr/bin:/bin", "CLAUDE_CONFIG_DIR": str(config), **(env or {})},
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
            cwd=tmp_path,
        )
        return json.loads(completed.stdout), config / POOL_PICK_FILE

    def test_each_exec_runs_on_the_picked_slot_and_records_it(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        snapshot = datetime.now(UTC).isoformat()
        (home / "claude" / "pool" / "headroom.json").write_text(
            json.dumps(
                {
                    "capturedAt": snapshot,
                    "slots": {
                        "claude-1": {"windows": [{"id": "five_hour", "percentRemaining": 3}]},
                        "claude-2": {"windows": [{"id": "five_hour", "percentRemaining": 80}]},
                    },
                }
            )
        )
        child, pick_file = self._run(tmp_path, home, "-p", "hi")
        assert child["token"] == _token("claude-2")
        record = json.loads(pick_file.read_text())
        assert {key: record[key] for key in ("slot", "reason", "percentRemaining")} == {
            "slot": "claude-2",
            "reason": "ranked",
            "percentRemaining": 80,
        }
        assert "sk-ant" not in pick_file.read_text()

    def test_the_wrapper_passes_over_a_slot_this_session_saw_refused(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-5"])
        config = tmp_path / "cfg"
        config.mkdir()
        far = datetime.now(UTC).timestamp() + 3600
        (config / POOL_REFUSALS_FILE).write_text(json.dumps({"claude-5": {"account": far}}))
        for _ in range(5):
            child, pick_file = self._run(tmp_path, home)
            assert child["token"] == _token("claude-1")
            assert json.loads(pick_file.read_text())["slot"] == "claude-1"

    def test_the_wrapper_runs_on_the_slot_the_session_is_pinned_to(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        (home / "claude" / "pool" / "headroom.json").write_text(
            json.dumps(
                {
                    "capturedAt": datetime.now(UTC).isoformat(),
                    "slots": {
                        "claude-1": {"windows": [{"id": "five_hour", "percentRemaining": 80}]},
                        "claude-2": {"windows": [{"id": "five_hour", "percentRemaining": 25}]},
                    },
                }
            )
        )
        pinned = {PREFERRED_SLOT_ENV_VAR: "claude-2"}
        child, pick_file = self._run(tmp_path, home, "-p", "hi", env=pinned)
        assert child["token"] == _token("claude-2")
        record = json.loads(pick_file.read_text())
        assert {key: record[key] for key in ("slot", "reason", "percentRemaining")} == {
            "slot": "claude-2",
            "reason": "preferred",
            "percentRemaining": 25,
        }
        child, pick_file = self._run(tmp_path, home, env={PREFERRED_SLOT_ENV_VAR: ""})
        assert child["token"] == _token("claude-1")
        assert json.loads(pick_file.read_text())["reason"] == "ranked"

    def test_a_refused_pinned_slot_moves_the_wrapper_on(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        config = tmp_path / "cfg"
        config.mkdir()
        far = datetime.now(UTC).timestamp() + 3600
        (config / POOL_REFUSALS_FILE).write_text(json.dumps({"claude-2": {"account": far}}))
        for _ in range(5):
            child, pick_file = self._run(tmp_path, home, env={PREFERRED_SLOT_ENV_VAR: "claude-2"})
            assert child["token"] == _token("claude-1")
            assert json.loads(pick_file.read_text())["slot"] == "claude-1"

    def test_the_wrapper_and_its_picker_copy_hold_no_token(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1"])
        self._run(tmp_path, home)
        for path in (tmp_path / "bin").iterdir():
            assert "sk-ant-oat01-pool" not in path.read_text()

    def test_a_single_token_home_still_works(self, tmp_path: Path) -> None:
        home = _home(tmp_path, [], single=True)
        child, _ = self._run(tmp_path, home)
        assert child["token"] == "sk-ant-oat01-single-placeholder"


class TestRedactionAndReport:
    def test_every_pool_token_is_redacted(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2"])
        redactor = AuthHomeSecretRedactor(home)
        text = f"{_token('claude-1')} and {_token('claude-2')}"
        assert redactor.redact({"output": text}) == {"output": "*** and ***"}
        (home / "claude" / "pool" / "claude-3").mkdir()
        (home / "claude" / "pool" / "claude-3" / "oauth-token").write_text("late-added-token-value")
        assert redactor.redact({"output": "late-added-token-value"}) == {"output": "***"}

    def test_the_report_counts_slots_and_names_the_first_expiry(self, tmp_path: Path) -> None:
        home = _home(tmp_path, ["claude-1", "claude-2", "claude-3"])
        pool = home / "claude" / "pool"
        (pool / "claude-1" / "expires_at").write_text("2027-10-01T00:00:00Z\n")
        (pool / "claude-2" / "expires_at").write_text("2027-03-01T00:00:00Z\n")
        report = auth_home_boot_report(
            {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "anthropic"}
        )
        assert report == {
            "present": True,
            "providers": ["anthropic"],
            "claude_expires_at": "2027-03-01T00:00:00Z",
            "claude_pool_slots": 3,
        }
