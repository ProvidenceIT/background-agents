"""The bridge's boot report on a subscription home: presence and expiry, never a value."""

import os
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
