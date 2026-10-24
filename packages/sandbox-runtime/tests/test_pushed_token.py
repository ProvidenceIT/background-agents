"""Pushed SuperGrok and Antigravity access tokens: read, checked for life left, never echoed."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from sandbox_runtime import pushed_token
from sandbox_runtime.harness import HarnessStartError

if TYPE_CHECKING:
    from pathlib import Path

NOW = 1_800_000_000.0
GROK_TOKEN = "xai-placeholder-access-token-0001"
AGY_TOKEN = "ya29.placeholder-access-token-0002"


def _home(tmp_path: Path, cli: str = "grok", **overrides: object) -> Path:
    home = tmp_path / "sf-auth"
    (home / cli).mkdir(parents=True, exist_ok=True)
    payload: dict[str, object] = {
        "schema": 1,
        "provider": cli,
        "access_token": GROK_TOKEN if cli == "grok" else AGY_TOKEN,
        "expires_at": NOW + 3600,
        "pushed_at": NOW - 90,
        "source": "pc-test-desktop",
        "account_tag": "0a1b2c3d",
    }
    payload.update(overrides)
    (home / cli / "access.json").write_text(json.dumps(payload))
    return home


def _env(home: Path, providers: str = "xai,antigravity") -> dict[str, str]:
    return {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": providers}


def test_read_returns_the_pushed_fields(tmp_path: Path) -> None:
    token = pushed_token.read("grok", _env(_home(tmp_path)), now=NOW)

    assert token.cli == "grok"
    assert token.access_token == GROK_TOKEN
    assert token.expires_at == NOW + 3600
    assert token.pushed_at == NOW - 90
    assert token.source == "pc-test-desktop"
    assert token.account_tag == "0a1b2c3d"
    assert token.expires_in_seconds(NOW) == 3600
    assert GROK_TOKEN not in repr(token)


def test_agy_reads_its_own_directory_for_the_antigravity_provider(tmp_path: Path) -> None:
    home = _home(tmp_path, "agy")
    token = pushed_token.read("agy", _env(home, "antigravity"), now=NOW)
    assert token.access_token == AGY_TOKEN
    with pytest.raises(HarnessStartError, match="SuperGrok not enrolled for this home"):
        pushed_token.read("grok", _env(home, "antigravity"), now=NOW)


def test_under_ten_minutes_left_is_a_stale_push_and_never_shows_the_token(
    tmp_path: Path,
) -> None:
    home = _home(tmp_path, expires_at=NOW + 599, pushed_at=NOW - 3 * 3600)

    with pytest.raises(HarnessStartError) as raised:
        pushed_token.read("grok", _env(home), now=NOW)

    message = str(raised.value)
    assert message == (
        "SuperGrok credential push stale since 2027-01-15T05:00:00Z; "
        "check sf-cred-push.timer on pc-test-desktop"
    )
    assert "push stale since" in message
    assert GROK_TOKEN not in message
    assert GROK_TOKEN not in repr(raised.value.__cause__)


def test_a_caller_may_accept_less_life_left(tmp_path: Path) -> None:
    home = _home(tmp_path, expires_at=NOW + 300)
    token = pushed_token.read("grok", _env(home), now=NOW, min_remaining_seconds=120)
    assert token.expires_in_seconds(NOW) == 300
    with pytest.raises(HarnessStartError, match="push stale since"):
        pushed_token.read("grok", _env(home), now=NOW + 200, min_remaining_seconds=120)


def test_iso_timestamps_are_accepted(tmp_path: Path) -> None:
    home = _home(tmp_path, expires_at="2027-01-15T09:00:00Z", pushed_at="2027-01-15T08:00:00+00:00")
    token = pushed_token.read("grok", _env(home), now=NOW)
    assert token.expires_at == NOW + 3600
    assert token.pushed_at == NOW


@pytest.mark.parametrize(
    ("environ", "message"),
    [
        ({}, "SuperGrok needs a subscription home"),
        ({"SF_AUTH_HOME_PROVIDERS": "anthropic"}, "SuperGrok not enrolled for this home"),
    ],
)
def test_a_home_that_cannot_serve_grok_is_a_start_error(
    tmp_path: Path, environ: dict[str, str], message: str
) -> None:
    if environ:
        environ = {"SF_AUTH_HOME": str(_home(tmp_path)), **environ}
    with pytest.raises(HarnessStartError, match=message):
        pushed_token.read("grok", environ, now=NOW)


def test_a_missing_file_is_named_without_listing_the_home(tmp_path: Path) -> None:
    home = tmp_path / "sf-auth"
    home.mkdir()
    with pytest.raises(HarnessStartError, match=r"mounted but grok/access\.json missing"):
        pushed_token.read("grok", _env(home), now=NOW)


@pytest.mark.parametrize(
    "content",
    [
        "{not json " + GROK_TOKEN,
        json.dumps([GROK_TOKEN]),
        json.dumps({"schema": 2, "access_token": GROK_TOKEN, "expires_at": NOW + 3600}),
        json.dumps({"access_token": "", "expires_at": NOW + 3600}),
        json.dumps({"access_token": GROK_TOKEN, "expires_at": "soon"}),
        json.dumps({"access_token": GROK_TOKEN}),
    ],
)
def test_an_unusable_file_is_a_start_error_that_quotes_nothing(
    tmp_path: Path, content: str
) -> None:
    home = _home(tmp_path)
    (home / "grok" / "access.json").write_text(content)
    with pytest.raises(HarnessStartError) as raised:
        pushed_token.read("grok", _env(home), now=NOW)
    assert GROK_TOKEN not in str(raised.value)


def test_untrusted_tags_and_sources_are_dropped(tmp_path: Path) -> None:
    home = _home(tmp_path, account_tag="not a tag; rm -rf", source="host\nwith newline")
    token = pushed_token.read("grok", _env(home), now=NOW)
    assert token.account_tag is None
    assert token.source is None


def test_boot_status_reports_ages_and_tag_only(tmp_path: Path) -> None:
    home = _home(tmp_path)

    status = pushed_token.boot_status(home, "grok", now=NOW)

    assert status == {
        "present": True,
        "expires_in_s": 3600,
        "pushed_age_s": 90,
        "account_tag": "0a1b2c3d",
    }
    assert pushed_token.boot_status(home, "agy", now=NOW) == {
        "present": False,
        "expires_in_s": None,
        "pushed_age_s": None,
        "account_tag": None,
    }
