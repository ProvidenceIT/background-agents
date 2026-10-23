"""The bridge's boot report on a subscription home: presence and expiry, never a value."""

import json
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

from sandbox_runtime.auth_home import auth_home_boot_report
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.repo_config import dump_repo_manifest

TOKEN = "sk-ant-oat01-subscriber-token"


def _home(tmp_path: Path, *, expires_at: str | None = "1790000000000") -> Path:
    home = tmp_path / "sf-auth"
    (home / "claude").mkdir(parents=True)
    (home / "claude" / "oauth-token").write_text(TOKEN)
    if expires_at is not None:
        (home / "claude" / "expires_at").write_text(expires_at + "\n")
    (home / "env").write_text("ZHIPU_API_KEY=glm-placeholder\n")
    return home


def _keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [key for item_key, item in value.items() for key in (item_key, *_keys(item))]
    if isinstance(value, list):
        return [key for item in value for key in _keys(item)]
    return []


def test_no_home_expected_reports_nothing() -> None:
    assert auth_home_boot_report({}) is None


def test_a_mounted_home_reports_presence_providers_and_expiry(tmp_path: Path) -> None:
    home = _home(tmp_path)
    assert auth_home_boot_report(
        {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "anthropic, openai"}
    ) == {"present": True, "providers": ["anthropic", "openai"], "claude_expires_at": 1790000000000}


def test_an_expected_home_that_is_not_mounted_says_so(tmp_path: Path) -> None:
    assert auth_home_boot_report(
        {"SF_AUTH_HOME": str(tmp_path / "missing"), "SF_AUTH_HOME_PROVIDERS": "anthropic"}
    ) == {"present": False, "providers": ["anthropic"], "claude_expires_at": None}


def test_an_unusable_expiry_is_not_echoed(tmp_path: Path) -> None:
    home = _home(tmp_path, expires_at="x" * 33)
    report = auth_home_boot_report({"SF_AUTH_HOME": str(home)})
    assert report == {"present": True, "providers": [], "claude_expires_at": None}
    iso = _home(tmp_path / "iso", expires_at="2026-11-01T00:00:00Z")
    assert auth_home_boot_report({"SF_AUTH_HOME": str(iso)})["claude_expires_at"] == (
        "2026-11-01T00:00:00Z"
    )


def _bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
    )
    manifest = tmp_path / "repositories.json"
    manifest.write_text(dump_repo_manifest([]))
    bridge.repo_manifest_path = manifest
    return bridge


def test_the_ready_event_carries_the_report_and_no_token(tmp_path: Path) -> None:
    home = _home(tmp_path)
    bridge = _bridge(tmp_path)
    with patch.dict(
        os.environ,
        {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "anthropic", "SANDBOX_VERSION": ""},
    ):
        event = bridge._build_ready_event()

    assert event["auth_home"] == {
        "present": True,
        "providers": ["anthropic"],
        "claude_expires_at": 1790000000000,
    }
    assert not [key for key in _keys(event) if "token" in key.lower()]
    assert TOKEN not in repr(event)
    assert "glm-placeholder" not in repr(event)


def test_the_ready_event_without_a_home_is_unchanged(tmp_path: Path) -> None:
    bridge = _bridge(tmp_path)
    environ = {key: value for key, value in os.environ.items() if not key.startswith("SF_AUTH")}
    with patch.dict(os.environ, environ, clear=True):
        event = bridge._build_ready_event()
    assert "auth_home" not in event


def _codex_pool_home(tmp_path: Path) -> Path:
    home = tmp_path / "sf-auth-codex"
    (home / "codex").mkdir(parents=True)
    for slot in ("codex-1", "codex-2", "codex-3"):
        (home / "codex-pool" / slot).mkdir(parents=True)
        (home / "codex-pool" / slot / "auth.json").write_text('{"tokens": "codex-placeholder"}')
    return home


def test_a_codex_pool_reports_slots_blocks_and_headroom_age_without_opening_a_login(
    tmp_path: Path, monkeypatch
) -> None:
    import builtins
    import io
    import json
    import time
    from datetime import UTC, datetime

    from sandbox_runtime.harness import codex_pool

    home = _codex_pool_home(tmp_path)
    pool = home / "codex-pool"
    now = time.time()
    codex_pool.mark_exhausted(pool, "codex-1", now + 3600, now=now)
    codex_pool.mark_auth_refused(pool, "codex-2", now=now)
    (pool / "headroom.json").write_text(
        json.dumps(
            {
                "capturedAt": datetime.fromtimestamp(now - 120, UTC).isoformat(),
                "slots": {
                    "codex-3": {
                        "windows": [
                            {
                                "id": "weekly",
                                "percentRemaining": 1,
                                "resetsAt": datetime.fromtimestamp(now + 60, UTC).isoformat(),
                            }
                        ]
                    }
                },
            }
        )
    )
    (home / "codex" / "auth.json").symlink_to("../codex-pool/codex-1/auth.json")

    opened: list[str] = []
    real_open = io.open

    def spy(file: Any, *args: Any, **kwargs: Any) -> Any:
        opened.append(str(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(io, "open", spy)
    monkeypatch.setattr(builtins, "open", spy)
    report = auth_home_boot_report({"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "openai"})

    assert report is not None
    assert report["codex_pool_slots"] == 3
    assert report["codex_pool_blocked"] == {
        "codex-1": "exhausted",
        "codex-2": "auth_refused",
        "codex-3": "headroom",
    }
    assert 119 <= report["codex_pool_headroom_age_s"] <= 180
    assert report["codex_pool_legacy_file"] is False
    assert opened, "the spy must see the state and headroom reads"
    assert not [path for path in opened if path.endswith("auth.json")]
    assert "codex-placeholder" not in repr(report)


def test_a_legacy_codex_login_beside_a_pool_is_reported(tmp_path: Path) -> None:
    home = _codex_pool_home(tmp_path)
    (home / "codex" / "auth.json").write_text('{"tokens": "legacy"}')
    report = auth_home_boot_report({"SF_AUTH_HOME": str(home)})
    assert report is not None
    assert report["codex_pool_legacy_file"] is True
    assert report["codex_pool_headroom_age_s"] is None


def test_a_codex_slot_with_an_empty_or_missing_login_is_reported(tmp_path: Path) -> None:
    home = _codex_pool_home(tmp_path)
    (home / "codex-pool" / "codex-2" / "auth.json").write_text("")
    (home / "codex-pool" / "codex-3" / "auth.json").unlink()
    report = auth_home_boot_report({"SF_AUTH_HOME": str(home)})
    assert report is not None
    assert report["codex_pool_slots"] == 1
    assert report["codex_pool_blocked"] == {"codex-2": "empty_login", "codex-3": "missing_login"}
    (home / "codex-pool" / "codex-1" / "auth.json").write_text("")
    report = auth_home_boot_report({"SF_AUTH_HOME": str(home)})
    assert report is not None
    assert report["codex_pool_slots"] == 0
    assert set(report["codex_pool_blocked"].values()) == {"empty_login", "missing_login"}


def test_a_home_without_a_codex_pool_reports_no_pool_keys(tmp_path: Path) -> None:
    report = auth_home_boot_report({"SF_AUTH_HOME": str(_home(tmp_path))})
    assert report is not None
    assert not [key for key in report if key.startswith("codex_pool")]


def _pushed_home(tmp_path: Path, now: float) -> Path:
    home = tmp_path / "sf-auth-pushed"
    (home / "grok").mkdir(parents=True)
    (home / "grok" / "access.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "provider": "grok",
                "access_token": "xai-placeholder-pushed-access-token",
                "expires_at": now + 3600,
                "pushed_at": now - 120,
                "source": "pc-test-desktop",
                "account_tag": "0a1b2c3d",
            }
        )
    )
    return home


def test_pushed_tokens_report_their_ages_and_tag_never_a_value(tmp_path: Path) -> None:
    now = time.time()
    home = _pushed_home(tmp_path, now)

    report = auth_home_boot_report(
        {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "xai,antigravity"}
    )

    assert report is not None
    pushed = report["pushed_credentials"]
    assert set(pushed) == {"grok", "agy"}
    assert pushed["grok"]["present"] is True
    assert 3590 <= pushed["grok"]["expires_in_s"] <= 3600
    assert 120 <= pushed["grok"]["pushed_age_s"] <= 130
    assert pushed["grok"]["account_tag"] == "0a1b2c3d"
    assert pushed["agy"] == {
        "present": False,
        "expires_in_s": None,
        "pushed_age_s": None,
        "account_tag": None,
    }
    assert "xai-placeholder-pushed-access-token" not in repr(report)
    assert not [key for key in _keys(report) if "token" in key.lower()]


def test_a_home_without_pushed_clis_reports_no_pushed_key(tmp_path: Path) -> None:
    report = auth_home_boot_report(
        {"SF_AUTH_HOME": str(_home(tmp_path)), "SF_AUTH_HOME_PROVIDERS": "anthropic"}
    )
    assert report is not None
    assert "pushed_credentials" not in report
