"""Pick the Claude subscription a child runs on, from the home's token pool.

A home may carry several Claude subscriptions, one ``claude setup-token``
per slot under ``claude/pool/<slot>/oauth-token``. The owner's PC, which
already reads every subscription's headroom for its own fleet, pushes the
percentages (never a credential) to ``claude/pool/headroom.json``. The
wrapper calls :func:`pick_slot` at every exec, so each child starts on the
subscription with the most headroom left. A child serves turns until one
fails on a subscription limit; the harness then records that slot as refused
until the window resets (:func:`record_refusal`) and starts a new child for
the next turn, whose pick passes the refused slot over, so a turn after an
exhausted one moves on by itself.

Rules, in order:

1. A window known to be exhausted (at or below ``EXHAUSTED_PERCENT``) with a
   reset still ahead rules its slot out. This holds for an old snapshot too:
   an exhausted window stays exhausted until its reset, whoever reported it.
   A refusal this session recorded rules its slot out the same way; a
   refusal of a model window (``seven_day_opus``) only for that model.
   A preferred slot (a session pinned to one subscription) is used whenever
   this rule leaves it open; otherwise the rules below pick as usual.
2. With a fresh snapshot, slots with a reading rank by their tightest
   window: five-hour, week, and a model window the ``--model`` argument
   names (``fable`` for ``claude-fable-5-1``). One is chosen at random from
   those within ``SPREAD_PERCENT`` of the best, so parallel sessions do not
   all land on the same subscription.
3. Otherwise (a stale or missing snapshot, or slots it has no reading for)
   the choice is uniform over the slots rule 1 left. Missing beats wrong:
   an old percentage is never ranked.
4. If rule 1 rules every slot out, the slot whose exhaustion ends first is
   used, so the CLI reports the real limit instead of a missing token.

A home without a pool keeps its single ``claude/oauth-token`` (slot
``default``). This module imports only the standard library: the wrapper
embeds its source, so it must run in the child's interpreter as is.
"""

from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from pathlib import Path

POOL_DIR = "pool"
HEADROOM_FILE = "headroom.json"
TOKEN_FILE = "oauth-token"
SINGLE_TOKEN_FILE = "oauth-token"
DEFAULT_SLOT = "default"

# A snapshot older than this is not ranked (the PC publishes every minute).
FRESH_SECONDS = 15 * 60
# At or below this many percent a window counts as exhausted.
EXHAUSTED_PERCENT = 5
# Slots this close to the best are equally good; spread sessions over them.
SPREAD_PERCENT = 10
# The account windows every model draws on.
ACCOUNT_WINDOWS = ("five_hour", "seven_day")
# A refusal of one of these limit windows blocks only that model's window.
MODEL_LIMIT_WINDOWS = {"seven_day_opus": "opus", "seven_day_sonnet": "sonnet"}
# The refusal scope that blocks a slot for every model.
ACCOUNT_REFUSAL = "account"
# How long a refusal without a reported reset keeps its slot out.
UNKNOWN_RESET_BLOCK_SECONDS = 60 * 60

_SLOT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")
_MODEL_WINDOW = re.compile(r"^[a-z][a-z0-9_]{0,23}$")


@dataclass(frozen=True)
class Window:
    id: str
    percent_remaining: int
    resets_at: float | None


@dataclass(frozen=True)
class Ranked:
    """What :func:`rank_pick` chose, without a file: the caller maps the slot to its own."""

    slot: str
    # ``preferred``, ``ranked``, ``spread`` (no fresh ranking) or ``exhausted`` (every slot is).
    reason: str
    percent_remaining: int | None


@dataclass(frozen=True)
class Pick:
    slot: str
    token_file: Path
    # Why this slot: ``preferred``, ``ranked``, ``spread`` (no fresh ranking), ``exhausted``.
    reason: str
    percent_remaining: int | None


def pool_slots(claude_dir: Path) -> dict[str, Path]:
    """Every slot with a non-empty token file, by name; the single token as ``default``."""
    slots: dict[str, Path] = {}
    pool = claude_dir / POOL_DIR
    try:
        entries = sorted(pool.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        token = entry / TOKEN_FILE
        if _SLOT_NAME.match(entry.name) and _non_empty(token):
            slots[entry.name] = token
    if not slots and _non_empty(claude_dir / SINGLE_TOKEN_FILE):
        slots[DEFAULT_SLOT] = claude_dir / SINGLE_TOKEN_FILE
    return slots


def model_window(argv: list[str]) -> str | None:
    """The named-model window a ``--model`` argument draws on, e.g. ``fable``."""
    model = None
    for index, arg in enumerate(argv):
        if arg == "--model" and index + 1 < len(argv):
            model = argv[index + 1]
        elif arg.startswith("--model="):
            model = arg.split("=", 1)[1]
    if not model:
        return None
    parts = model.lower().split("-")
    name = parts[1] if len(parts) > 1 and parts[0] == "claude" else parts[0]
    return name if _MODEL_WINDOW.match(name) else None


def read_headroom(claude_dir: Path) -> tuple[float | None, dict[str, list[Window]]]:
    """``(captured_at, windows by slot)``; ``(None, {})`` when unreadable."""
    return read_headroom_file(claude_dir / POOL_DIR / HEADROOM_FILE)


def read_headroom_file(path: Path) -> tuple[float | None, dict[str, list[Window]]]:
    """A pushed headroom snapshot as ``(captured_at, windows by slot)``; ``(None, {})`` when unreadable."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None, {}
    if not isinstance(raw, dict):
        return None, {}
    captured_at = _timestamp(raw.get("capturedAt"))
    readings: dict[str, list[Window]] = {}
    slots = raw.get("slots")
    if isinstance(slots, dict):
        for slot, entry in slots.items():
            windows = entry.get("windows") if isinstance(entry, dict) else None
            if isinstance(slot, str) and isinstance(windows, list):
                readings[slot] = [w for w in map(_window, windows) if w is not None]
    return captured_at, readings


def is_fresh(captured_at: float | None, now: float) -> bool:
    """Whether a snapshot taken at ``captured_at`` may be ranked at ``now``."""
    return captured_at is not None and 0 <= now - captured_at <= FRESH_SECONDS


def refusal_scope(limit_window: str) -> str:
    """What a refusal of ``limit_window`` blocks: one model's window, else the whole slot."""
    return MODEL_LIMIT_WINDOWS.get(limit_window, ACCOUNT_REFUSAL)


def read_refusals(path: Path, now: float, model_windows: Iterable[str] = ()) -> dict[str, float]:
    """Slots a limit refused, by name, with the time each refusal ends; past ones dropped.

    A refusal of a model window counts only when ``model_windows`` names it,
    so an Opus refusal does not keep the slot from a Sonnet turn.
    """
    scopes = {ACCOUNT_REFUSAL, *model_windows}
    refusals: dict[str, float] = {}
    for slot, entry in _live_refusals(path, now).items():
        ends = [until for scope, until in entry.items() if scope in scopes]
        if ends:
            refusals[slot] = max(ends)
    return refusals


def record_refusal(
    path: Path,
    slot: str,
    resets_at: float | None,
    now: float,
    *,
    scope: str = ACCOUNT_REFUSAL,
) -> None:
    """Rule ``slot`` out of later picks for ``scope`` until ``resets_at`` (or a default hour)."""
    refusals = _live_refusals(path, now)
    until = resets_at if resets_at is not None and resets_at > now else None
    refusals.setdefault(slot, {})[scope] = (
        until if until is not None else now + UNKNOWN_RESET_BLOCK_SECONDS
    )
    path.write_text(json.dumps(refusals, sort_keys=True), encoding="utf-8")


def _live_refusals(path: Path, now: float) -> dict[str, dict[str, float]]:
    """The refusals file as ``{slot: {scope: until}}``, without ended or malformed entries."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    refusals: dict[str, dict[str, float]] = {}
    for slot, entry in raw.items():
        if not isinstance(slot, str) or not isinstance(entry, dict):
            continue
        live = {}
        for scope, until in entry.items():
            end = _timestamp_seconds(until)
            if isinstance(scope, str) and end is not None and end > now:
                live[scope] = end
        if live:
            refusals[slot] = live
    return refusals


def _timestamp_seconds(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def pick_slot(
    claude_dir: Path,
    argv: list[str],
    *,
    refusals_file: Path | None = None,
    preferred: str | None = None,
    now: float | None = None,
    rng: random.Random | None = None,
) -> Pick | None:
    """The slot this exec runs on, or ``None`` when the home holds no token.

    ``preferred`` names the slot the session is pinned to; a name the home
    has no token for is ignored.
    """
    slots = pool_slots(claude_dir)
    if not slots:
        return None
    now = time.time() if now is None else now
    captured_at, readings = read_headroom(claude_dir)
    extra = tuple(filter(None, [model_window(argv)]))
    ranked = rank_pick(
        slots,
        readings,
        captured_at,
        account_windows=ACCOUNT_WINDOWS,
        extra_windows=extra,
        blocked_until=read_refusals(refusals_file, now, extra) if refusals_file else None,
        preferred=preferred,
        now=now,
        rng=rng or random.Random(),
    )
    if ranked is None:
        return None
    return Pick(ranked.slot, slots[ranked.slot], ranked.reason, ranked.percent_remaining)


def rank_pick(
    slots: Iterable[str],
    readings: Mapping[str, list[Window]],
    captured_at: float | None,
    *,
    account_windows: tuple[str, ...] | None,
    extra_windows: tuple[str, ...] = (),
    blocked_until: Mapping[str, float] | None = None,
    preferred: str | None = None,
    now: float,
    rng: random.Random,
) -> Ranked | None:
    """Rules 1 to 4 over ``slots``; ``None`` only when there is no slot at all.

    ``account_windows`` names the windows every model draws on (``None``: any
    window the snapshot has, as for Codex, whose rows carry one ``weekly``
    window), and ``extra_windows`` the model windows that bound the choice
    too. ``blocked_until`` rules a slot out until the given time, on top of
    the snapshot (the caller's own exhaustion marks). ``preferred`` wins
    whenever it is one of ``slots`` and rule 1 leaves it open.
    """
    names = list(slots)
    if not names:
        return None
    blocks = blocked_until or {}
    fresh = is_fresh(captured_at, now)

    def counts(window: Window) -> bool:
        return account_windows is None or window.id in account_windows

    def relevant(slot: str) -> list[Window]:
        return [w for w in readings.get(slot, []) if counts(w) or w.id in extra_windows]

    def exhausted_until(slot: str) -> float | None:
        ends = [
            w.resets_at
            for w in relevant(slot)
            if w.percent_remaining <= EXHAUSTED_PERCENT
            and w.resets_at is not None
            and w.resets_at > now
        ]
        block = blocks.get(slot)
        if block is not None and block > now:
            ends.append(block)
        return max(ends) if ends else None

    def tightest(slot: str) -> int:
        return min(w.percent_remaining for w in relevant(slot))

    open_slots = [slot for slot in names if exhausted_until(slot) is None]
    if preferred in open_slots:
        read = fresh and any(counts(w) for w in relevant(preferred))
        return Ranked(preferred, "preferred", tightest(preferred) if read else None)
    if not open_slots:
        slot = min(names, key=lambda s: (exhausted_until(s) or now, s))
        return Ranked(slot, "exhausted", 0)

    if fresh:
        scores = {
            slot: tightest(slot) for slot in open_slots if any(counts(w) for w in relevant(slot))
        }
        ranked = {slot: score for slot, score in scores.items() if score > EXHAUSTED_PERCENT}
        if ranked:
            best = max(ranked.values())
            near = sorted(slot for slot, score in ranked.items() if score >= best - SPREAD_PERCENT)
            slot = rng.choice(near)
            return Ranked(slot, "ranked", ranked[slot])
        unread = [slot for slot in open_slots if slot not in scores]
        if unread:
            open_slots = unread

    slot = rng.choice(sorted(open_slots))
    return Ranked(slot, "spread", None)


def _non_empty(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0 and bool(path.read_text().strip())
    except (OSError, UnicodeDecodeError):
        return False


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _window(raw: object) -> Window | None:
    if not isinstance(raw, dict):
        return None
    window_id = raw.get("id")
    percent = raw.get("percentRemaining")
    if not isinstance(window_id, str) or not isinstance(percent, int) or isinstance(percent, bool):
        return None
    if not 0 <= percent <= 100:
        return None
    return Window(window_id, percent, _timestamp(raw.get("resetsAt")))
