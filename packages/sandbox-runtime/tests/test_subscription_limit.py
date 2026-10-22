"""The ``limit`` object a failed ``execution_complete`` carries."""

from __future__ import annotations

import pytest

from sandbox_runtime.harness import SubscriptionLimit, TurnOutcome


def test_wire_shape_uses_epoch_milliseconds_and_camel_case():
    limit = SubscriptionLimit.of("five_hour", 1_790_000_000)
    assert limit.wire(harness="claude", subscription_slot="claude-5") == {
        "kind": "subscription_limit",
        "window": "five_hour",
        "resetsAtMs": 1_790_000_000_000,
        "subscriptionSlot": "claude-5",
        "harness": "claude",
    }


def test_wire_shape_without_reset_or_slot():
    assert SubscriptionLimit.of(None).wire(harness="claude", subscription_slot=None) == {
        "kind": "subscription_limit",
        "window": "unknown",
        "resetsAtMs": None,
        "subscriptionSlot": None,
        "harness": "claude",
    }


@pytest.mark.parametrize(
    "window,expected",
    [
        ("five_hour", "five_hour"),
        ("seven_day", "seven_day"),
        ("seven_day_opus", "seven_day_opus"),
        ("seven_day_sonnet", "seven_day_sonnet"),
        ("overage", "overage"),
        ("seven_day_fable", "unknown"),
        (None, "unknown"),
        (5, "unknown"),
    ],
)
def test_windows_the_control_plane_does_not_know_become_unknown(window, expected):
    assert SubscriptionLimit.of(window).window == expected


@pytest.mark.parametrize("resets_at", [0, -5, "1790000000", True])
def test_unusable_reset_times_are_dropped(resets_at):
    assert SubscriptionLimit.of("five_hour", resets_at).resets_at is None


def test_fractional_seconds_truncate_to_whole_milliseconds():
    wire = SubscriptionLimit.of("five_hour", 1_790_000_000.1239).wire(
        harness="claude", subscription_slot=None
    )
    assert wire["resetsAtMs"] == 1_790_000_000_123


def test_only_a_failed_turn_carries_a_limit():
    with pytest.raises(ValueError, match="only a failed turn"):
        TurnOutcome(success=True, limit=SubscriptionLimit.of("five_hour"))
    failed = TurnOutcome.failed("limit", limit=SubscriptionLimit.of("five_hour"))
    assert failed.limit == SubscriptionLimit(window="five_hour")
