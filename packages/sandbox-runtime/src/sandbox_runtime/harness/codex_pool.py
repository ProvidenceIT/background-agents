"""Pick the ChatGPT subscription a Codex turn runs on, from the home's login pool.

A Codex home may carry several ChatGPT logins, one fresh ``codex login
--device-auth`` per slot under ``codex-pool/<slot>/auth.json``, beside the
``codex/`` directory that is ``CODEX_HOME``. Codex keeps every other piece of
state (``sessions/``, the sqlite files, ``config.toml``) in ``codex/``, so a
thread resumes whichever slot ran its last turn. Before each attempt the
harness points ``codex/auth.json`` at the chosen slot with a relative symlink;
Codex saves a refreshed token with open+truncate on that path, so the refresh
lands in the slot's own file. The harness only stats slot files and swaps the
link: it never opens or copies a login.

The owner's PC pushes the slots' headroom (percentages only) to
``codex-pool/headroom.json`` in the format the Claude pool uses. The seated
harness keeps its own marks in ``codex-pool/state.json``: when a slot hit its
usage limit or was refused, and which slot ran each thread. ``force-slot``
(one slot name) pins every pick, for tests and emergencies. ``legacy-slot``
(one slot name, written by the owner's ``--adopt-legacy``) names the account
that made every thread from before the pool.

Pick rules, before every attempt (see notes/sf-codex-pool.md):

1. Slots are regular, non-empty ``auth.json`` files with a safe name; slots
   already tried in this turn are left out.
2. ``force-slot`` naming an untried slot wins.
3. Blocked: an ``exhaustedUntil`` still ahead, an ``authRefused`` mark while
   the file is unchanged, and an exhausted headroom window with a reset still
   ahead. Only a mark taken from the snapshot's own window is cleared early,
   by a fresh snapshot taken after the mark that shows headroom again: the
   snapshot carries the weekly window only, so it says nothing about a
   shorter limit Codex reported.
4. Sticky: the thread's last slot, while open and not known to be low. A
   thread the pool has no record of (made before the pool) keeps to
   ``legacy-slot``, or else to the slot ``codex/auth.json`` links to now.
5. Ranked or spread as for Claude, over any window id.
6. Nothing open: the earliest reset on a turn's first attempt (so Codex
   reports the real limit), ``None`` on a retry.

Standard library only, like ``claude_pool``.
"""

from __future__ import annotations

import contextlib
import enum
import json
import math
import os
import random
import re
import stat
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from . import claude_pool
from .claude_pool import EXHAUSTED_PERCENT, Window

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

POOL_DIR: Final = "codex-pool"
AUTH_FILE: Final = "auth.json"
HEADROOM_FILE: Final = "headroom.json"
STATE_FILE: Final = "state.json"
FORCE_FILE: Final = "force-slot"
LEGACY_SLOT_FILE: Final = "legacy-slot"
# The record of the last pick, in the harness's config directory (never the home).
PICK_FILE: Final = "sf-codex-pool-pick.json"
# The temporary link next to codex/auth.json that is renamed over it.
LINK_TMP: Final = ".auth.json.sf-pool-link"
# Thread -> slot entries kept in state.json, newest last.
MAX_THREADS: Final = 500

# Without a reset time from the snapshot or Codex's own text.
DEFAULT_EXHAUSTION_SECONDS: Final = 30 * 60
# A plan that does not include Codex will not include it in an hour either.
NOT_INCLUDED_SECONDS: Final = 24 * 3600
# No limit Codex reports is longer than a week; a parse that says so is wrong.
MAX_EXHAUSTION_SECONDS: Final = 8 * 24 * 3600

# Where an exhaustion mark's time came from (``state.json`` ``source``). Only a
# ``headroom`` mark is about the window the snapshot shows.
MARK_FROM_HEADROOM: Final = "headroom"
MARK_FROM_RETRY_AT: Final = "retry_at"
MARK_FROM_DEFAULT: Final = "default"
MARK_NOT_INCLUDED: Final = "not_included"

# Codex writes "You\u2019ve hit your usage limit"; markers use an ASCII apostrophe.
_RIGHT_QUOTE: Final = "\u2019"
_SLOT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$")


class FailureKind(enum.StrEnum):
    """How a failed attempt is handled; ``OTHER`` is today's path."""

    USAGE_LIMIT = "usage_limit"
    FOREIGN_THREAD = "foreign_thread"
    AUTH_REFUSED = "auth_refused"
    OTHER = "other"


# Matched case-insensitively against Codex's Display strings (codex-rs
# protocol/src/error.rs and login/src/auth/manager.rs at rust-v0.162.0).
# Re-check them whenever the CLI pin moves.
USAGE_LIMIT_MARKERS: Final = (
    "hit your usage limit",
    "usage_limit_reached",
    "out of credits",
    "spend cap",
    "usage_not_included",
    "to use codex with your chatgpt plan",
    "insufficient_quota",
    "quota exceeded",
)
NOT_INCLUDED_MARKERS: Final = ("usage_not_included", "to use codex with your chatgpt plan")
FOREIGN_THREAD_MARKERS: Final = (
    "invalid_encrypted_content",
    "could not be verified",
    "organization_id did not match",
)
AUTH_REFUSED_MARKERS: Final = (
    "401 unauthorized",
    "refresh_token",
    "not logged in",
    "could not be refreshed",
)

CONTINUE_PROMPT: Final = (
    "The previous attempt at this request was interrupted by an account usage limit after "
    "partial progress. Continue from where it stopped; do not redo completed steps; check "
    "the working tree first."
)
HANDOFF_MAX_CHARS: Final = 60_000


@dataclass(frozen=True)
class CodexPick:
    slot: str
    auth_file: Path
    # ``forced``, ``sticky``, ``ranked``, ``spread`` or ``exhausted``.
    reason: str
    percent_remaining: int | None


class LinkState(enum.StrEnum):
    """What ``codex/auth.json`` is."""

    ABSENT = "absent"
    POOL_LINK = "pool_link"
    LEGACY_FILE = "legacy_file"
    FOREIGN_LINK = "foreign_link"


# --- slots -----------------------------------------------------------------


def pool_root(auth_home: Path) -> Path:
    """``<home>/codex-pool``: beside ``codex/``, so Codex never sees the other logins."""
    return auth_home / POOL_DIR


def pool_slots(root: Path) -> dict[str, Path]:
    """Every slot with a regular, non-empty ``auth.json``, by name (lstat and size only)."""
    slots: dict[str, Path] = {}
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return slots
    for entry in entries:
        if not _SLOT_NAME.match(entry.name):
            continue
        auth = entry / AUTH_FILE
        try:
            info = auth.lstat()
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode) and info.st_size > 0:
            slots[entry.name] = auth
    return slots


def unusable_slots(root: Path) -> dict[str, str]:
    """Slot directories that hold no usable login, ``{slot: reason}`` (lstat only).

    ``missing_login`` (no file yet, or an enrolment in progress), ``empty_login``
    (a refresh killed between Codex's truncate and its write leaves this, and
    the login is then lost) or ``not_a_file``. The owner re-enrols such a slot.
    """
    found: dict[str, str] = {}
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not _SLOT_NAME.match(entry.name) or not entry.is_dir():
            continue
        try:
            info = (entry / AUTH_FILE).lstat()
        except FileNotFoundError:
            found[entry.name] = "missing_login"
            continue
        except OSError:
            found[entry.name] = "not_a_file"
            continue
        if not stat.S_ISREG(info.st_mode):
            found[entry.name] = "not_a_file"
        elif info.st_size == 0:
            found[entry.name] = "empty_login"
    return found


def link_state(codex_dir: Path, root: Path) -> LinkState:
    """Whether ``codex/auth.json`` is missing, a link into the pool, a file, or a link elsewhere."""
    auth = codex_dir / AUTH_FILE
    try:
        info = auth.lstat()
    except FileNotFoundError:
        return LinkState.ABSENT
    except OSError:
        return LinkState.FOREIGN_LINK
    if stat.S_ISREG(info.st_mode):
        return LinkState.LEGACY_FILE
    if not stat.S_ISLNK(info.st_mode):
        return LinkState.FOREIGN_LINK
    return (
        LinkState.POOL_LINK if linked_slot(codex_dir, root) is not None else LinkState.FOREIGN_LINK
    )


def linked_slot(codex_dir: Path, root: Path) -> str | None:
    """The slot ``codex/auth.json`` links to, or ``None`` when it is not a pool link."""
    try:
        target = (codex_dir / AUTH_FILE).readlink()
    except OSError:
        return None
    resolved = Path(os.path.normpath(codex_dir / target))
    if resolved.name != AUTH_FILE or resolved.parent.parent != Path(os.path.normpath(root)):
        return None
    slot = resolved.parent.name
    return slot if _SLOT_NAME.match(slot) else None


def point_auth(codex_dir: Path, root: Path, slot: str) -> bool:
    """Link ``codex/auth.json`` to ``slot`` atomically; ``True`` when it changed.

    Refuses (``FileExistsError``) to replace a regular file or a directory: a
    legacy login is moved into the pool by the owner, never overwritten here.
    The link is relative, so it resolves on the node and in the pod alike.
    """
    if not _SLOT_NAME.match(slot):
        raise ValueError(f"not a pool slot name: {slot!r}")
    auth = codex_dir / AUTH_FILE
    target = os.path.relpath(root / slot / AUTH_FILE, codex_dir)
    try:
        info = auth.lstat()
    except FileNotFoundError:
        info = None
    if info is not None:
        if not stat.S_ISLNK(info.st_mode):
            raise FileExistsError(f"{auth} is not a pool link; it is left as it is")
        if str(auth.readlink()) == target:
            return False
    tmp = codex_dir / LINK_TMP
    with contextlib.suppress(FileNotFoundError):
        tmp.unlink()
    tmp.symlink_to(target)
    tmp.replace(auth)
    return True


def read_force(root: Path) -> str | None:
    return _read_slot_name(root / FORCE_FILE)


def read_legacy_slot(root: Path) -> str | None:
    """The slot the home's pre-pool login was moved into (``--adopt-legacy``), if recorded."""
    return _read_slot_name(root / LEGACY_SLOT_FILE)


def _read_slot_name(path: Path) -> str | None:
    try:
        name = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return name if _SLOT_NAME.match(name) else None


# --- state -----------------------------------------------------------------


def read_state(root: Path) -> dict[str, Any]:
    """``{"slots": {...}, "threads": {...}}``; a missing or malformed file reads as empty."""
    try:
        raw = json.loads((root / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        raw = None
    if not isinstance(raw, dict):
        raw = {}
    slots = raw.get("slots")
    threads = raw.get("threads")
    return {
        "slots": {
            name: entry
            for name, entry in (slots.items() if isinstance(slots, dict) else ())
            if isinstance(name, str) and isinstance(entry, dict)
        },
        "threads": {
            thread: slot
            for thread, slot in (threads.items() if isinstance(threads, dict) else ())
            if isinstance(thread, str) and isinstance(slot, str)
        },
    }


def write_state(root: Path, state: Mapping[str, Any]) -> None:
    """Replace ``state.json`` atomically (temp file, then rename), mode 0640."""
    path = root / STATE_FILE
    tmp = root / f".{STATE_FILE}.{os.getpid()}.tmp"
    # Insertion order matters: the thread map keeps its newest entries last.
    payload = json.dumps({"version": 1, **state}, indent=1)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        tmp.replace(path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def mark_exhausted(
    root: Path, slot: str, until: float, *, now: float, source: str = MARK_FROM_DEFAULT
) -> None:
    """Block ``slot`` until ``until``; ``source`` says where that time came from."""
    state = read_state(root)
    entry = state["slots"].setdefault(slot, {})
    entry["exhaustedUntil"] = iso(until)
    entry["markedAt"] = iso(now)
    entry["source"] = source
    write_state(root, state)


def mark_auth_refused(root: Path, slot: str, *, now: float) -> None:
    """Block ``slot`` until its ``auth.json`` changes (a re-enrolment)."""
    signature = _signature(root / slot / AUTH_FILE)
    state = read_state(root)
    entry = state["slots"].setdefault(slot, {})
    entry["authRefused"] = (
        {"mtimeNs": signature[0], "size": signature[1]} if signature else {"mtimeNs": 0, "size": 0}
    )
    entry["markedAt"] = iso(now)
    write_state(root, state)


def record_thread_slot(root: Path, thread_id: str, slot: str) -> None:
    """Remember which slot ran ``thread_id`` last (the newest ``MAX_THREADS``)."""
    state = read_state(root)
    threads: dict[str, str] = state["threads"]
    if threads.get(thread_id) == slot and list(threads)[-1:] == [thread_id]:
        return
    threads.pop(thread_id, None)
    threads[thread_id] = slot
    while len(threads) > MAX_THREADS:
        threads.pop(next(iter(threads)))
    write_state(root, state)


# --- picking ---------------------------------------------------------------


def pick_codex_slot(
    root: Path,
    *,
    thread_id: str | None = None,
    tried: Iterable[str] = (),
    first_attempt: bool = True,
    now: float | None = None,
    rng: random.Random | None = None,
    codex_dir: Path | None = None,
) -> CodexPick | None:
    """The slot the next attempt runs on, or ``None`` when no untried slot can run it.

    ``codex_dir`` (``CODEX_HOME``) lets a thread the pool has no record of keep
    to the slot ``codex/auth.json`` links to when no ``legacy-slot`` is set.
    """
    tried_set = set(tried)
    slots = {name: path for name, path in pool_slots(root).items() if name not in tried_set}
    if not slots:
        return None
    now = time.time() if now is None else now
    rng = rng or random.Random()

    forced = read_force(root)
    if forced in slots:
        return CodexPick(forced, slots[forced], "forced", None)

    captured_at, readings = claude_pool.read_headroom_file(root / HEADROOM_FILE)
    blocks = blocked_until(root, slots, captured_at, readings, now)

    sticky = _thread_slot(root, thread_id, codex_dir)
    if sticky in slots and _open(sticky, blocks, readings, now):
        score = _fresh_score(readings.get(sticky, []), captured_at, now)
        if score is None or score > EXHAUSTED_PERCENT:
            return CodexPick(sticky, slots[sticky], "sticky", score)

    ranked = claude_pool.rank_pick(
        slots,
        readings,
        captured_at,
        account_windows=None,
        blocked_until=blocks,
        now=now,
        rng=rng,
    )
    if ranked is None or (ranked.reason == "exhausted" and not first_attempt):
        return None
    return CodexPick(ranked.slot, slots[ranked.slot], ranked.reason, ranked.percent_remaining)


def _thread_slot(root: Path, thread_id: str | None, codex_dir: Path | None) -> str | None:
    """The slot a thread belongs on: its last slot, else the pre-pool account's."""
    if not thread_id:
        return None
    known = read_state(root)["threads"].get(thread_id)
    if known is not None:
        return known
    legacy = read_legacy_slot(root)
    if legacy is not None:
        return legacy
    return linked_slot(codex_dir, root) if codex_dir is not None else None


def blocked_until(
    root: Path,
    slots: Mapping[str, Path],
    captured_at: float | None,
    readings: Mapping[str, list[Window]],
    now: float,
) -> dict[str, float]:
    """The harness's own marks that still hold, as ``{slot: until}`` (``inf``: until re-enrolled)."""
    blocks: dict[str, float] = {}
    for slot, entry in read_state(root)["slots"].items():
        if slot not in slots:
            continue
        refused = entry.get("authRefused")
        if isinstance(refused, dict) and _signature(slots[slot]) == (
            refused.get("mtimeNs"),
            refused.get("size"),
        ):
            blocks[slot] = math.inf
            continue
        until = _timestamp(entry.get("exhaustedUntil"))
        if until is None or until <= now:
            continue
        marked = _timestamp(entry.get("markedAt"))
        score = _fresh_score(readings.get(slot, []), captured_at, now)
        if (
            entry.get("source") == MARK_FROM_HEADROOM
            and score is not None
            and score > EXHAUSTED_PERCENT
            and captured_at is not None
            and (marked is None or captured_at > marked)
        ):
            continue  # a reading of the same window, taken after the mark, shows the reset
        blocks[slot] = until
    return blocks


def block_reasons(root: Path, *, now: float | None = None) -> dict[str, str]:
    """``{slot: reason}`` for every blocked slot, for the boot report (names only)."""
    now = time.time() if now is None else now
    slots = pool_slots(root)
    captured_at, readings = claude_pool.read_headroom_file(root / HEADROOM_FILE)
    reasons: dict[str, str] = {}
    for slot, until in blocked_until(root, slots, captured_at, readings, now).items():
        reasons[slot] = "auth_refused" if math.isinf(until) else "exhausted"
    for slot in slots:
        if slot not in reasons and _headroom_exhausted_until(readings.get(slot, []), now):
            reasons[slot] = "headroom"
    reasons.update(unusable_slots(root))
    return reasons


def headroom_age_seconds(root: Path, *, now: float | None = None) -> int | None:
    now = time.time() if now is None else now
    captured_at, _ = claude_pool.read_headroom_file(root / HEADROOM_FILE)
    return None if captured_at is None else int(now - captured_at)


def earliest_reset(root: Path, slots: Iterable[str], *, now: float | None = None) -> float | None:
    """When the first of ``slots`` comes back, from the harness's marks and the snapshot."""
    now = time.time() if now is None else now
    names = list(slots)
    available = pool_slots(root)
    captured_at, readings = claude_pool.read_headroom_file(root / HEADROOM_FILE)
    blocks = blocked_until(
        root, {n: available[n] for n in names if n in available}, captured_at, readings, now
    )
    ends = []
    for slot in names:
        candidates = [
            value
            for value in (blocks.get(slot), _headroom_exhausted_until(readings.get(slot, []), now))
            if value is not None and not math.isinf(value)
        ]
        if candidates:
            ends.append(max(candidates))
    return min(ends) if ends else None


def _open(
    slot: str, blocks: Mapping[str, float], readings: Mapping[str, list[Window]], now: float
) -> bool:
    return slot not in blocks and _headroom_exhausted_until(readings.get(slot, []), now) is None


def _fresh_score(windows: list[Window], captured_at: float | None, now: float) -> int | None:
    if not windows or not claude_pool.is_fresh(captured_at, now):
        return None
    return min(w.percent_remaining for w in windows)


def _headroom_exhausted_until(windows: list[Window], now: float) -> float | None:
    ends = [
        w.resets_at
        for w in windows
        if w.percent_remaining <= EXHAUSTED_PERCENT
        and w.resets_at is not None
        and w.resets_at > now
    ]
    return max(ends) if ends else None


# --- failures --------------------------------------------------------------


def classify_failure(text: str | None) -> FailureKind:
    """What a Codex failure message means for the pool."""
    if not text:
        return FailureKind.OTHER
    lowered = text.lower().replace(_RIGHT_QUOTE, "'")
    if any(marker in lowered for marker in USAGE_LIMIT_MARKERS):
        return FailureKind.USAGE_LIMIT
    if any(marker in lowered for marker in FOREIGN_THREAD_MARKERS):
        return FailureKind.FOREIGN_THREAD
    if any(marker in lowered for marker in AUTH_REFUSED_MARKERS):
        return FailureKind.AUTH_REFUSED
    return FailureKind.OTHER


# "try again at 5:11 AM." (same day) or "try again at Oct 20th, 2026 5:11 AM."
_RETRY_AT = re.compile(
    r"try again at (?:(?P<month>[A-Z][a-z]{2}) (?P<day>\d{1,2})(?:st|nd|rd|th)?, (?P<year>\d{4}) )?"
    r"(?P<hour>\d{1,2}):(?P<minute>\d{2}) ?(?P<ampm>[AP]M)",
    re.IGNORECASE,
)
_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def parse_retry_at(text: str, now: float) -> float | None:
    """The reset time in Codex's "try again at …" text, read in the pod's zone (UTC).

    The same-day form carries a clock time only; one already past means tomorrow.
    """
    match = _RETRY_AT.search(text or "")
    if match is None:
        return None
    hour = int(match["hour"]) % 12 + (12 if match["ampm"].upper() == "PM" else 0)
    minute = int(match["minute"])
    if hour > 23 or minute > 59:
        return None
    current = datetime.fromtimestamp(now, UTC)
    try:
        if match["month"]:
            month = _MONTHS.index(match["month"].lower()) + 1
            moment = datetime(
                int(match["year"]), month, int(match["day"]), hour, minute, tzinfo=UTC
            )
        else:
            moment = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if moment.timestamp() <= now:
                moment += timedelta(days=1)
    except ValueError:
        return None
    return moment.timestamp()


def reset_for(detail: str, windows: list[Window], now: float) -> float:
    """Until when a slot that hit its limit with ``detail`` stays out."""
    return exhaustion_mark(detail, windows, now)[0]


def exhaustion_mark(detail: str, windows: list[Window], now: float) -> tuple[float, str]:
    """``(until, source)`` for a slot that hit its limit with ``detail``.

    The source is ``headroom`` only when the snapshot's own window is the one
    that ran out; a later reading of that window may then clear the mark.
    """
    lowered = (detail or "").lower().replace(_RIGHT_QUOTE, "'")
    if any(marker in lowered for marker in NOT_INCLUDED_MARKERS):
        until, source = now + NOT_INCLUDED_SECONDS, MARK_NOT_INCLUDED
    elif (headroom := _headroom_exhausted_until(windows, now)) is not None:
        until, source = headroom, MARK_FROM_HEADROOM
    elif (retry_at := parse_retry_at(detail, now)) is not None:
        until, source = retry_at, MARK_FROM_RETRY_AT
    else:
        until, source = now + DEFAULT_EXHAUSTION_SECONDS, MARK_FROM_DEFAULT
    return min(max(until, now), now + MAX_EXHAUSTION_SECONDS), source


def build_handoff_prompt(rollout: Path | None, prompt: str) -> str:
    """``prompt`` preceded by the readable part of an earlier thread's rollout.

    Used when a thread cannot be resumed on the current account: user and
    assistant messages and short tool-call summaries, the newest
    ``HANDOFF_MAX_CHARS`` characters, never reasoning or compaction items.
    """
    lines: list[str] = []
    if rollout is not None:
        try:
            raw_lines = rollout.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            raw_lines = []
        for raw in raw_lines:
            line = _handoff_line(raw)
            if line:
                lines.append(line)
    transcript = "\n\n".join(lines)
    if len(transcript) > HANDOFF_MAX_CHARS:
        transcript = "[…]" + transcript[-HANDOFF_MAX_CHARS:]
    where = f" (full rollout: {rollout})" if rollout is not None else ""
    return (
        "[This conversation continues from an earlier Codex thread that could not be resumed "
        f"on the current subscription account{where}. Its transcript follows.]\n\n"
        f"{transcript or '(no readable messages)'}\n\n"
        "[End of the earlier transcript. The new message follows.]\n\n"
        f"{prompt}"
    )


def _handoff_line(raw: str) -> str | None:
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("type") != "response_item":
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    kind = payload.get("type")
    if kind == "message":
        role = payload.get("role")
        if role not in ("user", "assistant"):
            return None
        texts = [
            str(part.get("text") or "")
            for part in payload.get("content") or []
            if isinstance(part, dict) and part.get("type") in ("input_text", "output_text", "text")
        ]
        # Codex injects its environment and instructions as tagged user messages.
        text = "\n".join(t for t in texts if t and not t.lstrip().startswith("<")).strip()
        return f"{role}: {text}" if text else None
    if kind in ("function_call", "custom_tool_call", "local_shell_call"):
        name = str(payload.get("name") or kind)
        arguments = payload.get("arguments") or payload.get("input") or payload.get("action") or ""
        summary = arguments if isinstance(arguments, str) else json.dumps(arguments)
        summary = " ".join(summary.split())
        if len(summary) > 200:
            summary = summary[:200] + "…"
        return f"tool call: {name} {summary}".rstrip()
    return None


# --- helpers ---------------------------------------------------------------


def _signature(path: Path) -> tuple[int, int] | None:
    try:
        info = path.lstat()
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size)


def iso(timestamp: float) -> str:
    """A UTC timestamp as ``2026-10-20T05:11:04Z``."""
    return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
