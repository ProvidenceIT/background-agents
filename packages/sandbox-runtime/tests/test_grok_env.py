"""grok_env (child environment, config.toml, preflight) and grok_auth (the provider command)."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
import tomllib
from typing import TYPE_CHECKING

import pytest

from sandbox_runtime.harness import grok_auth
from sandbox_runtime.harness.base import HarnessStartError
from sandbox_runtime.harness.grok_env import (
    AUTH_PROVIDER_COMMAND_ENV_VAR,
    build_child_env,
    config_toml,
    preflight,
    require_enrolled_home,
    write_config,
)

if TYPE_CHECKING:
    from pathlib import Path

# A placeholder, never a real token.
FAKE_TOKEN = "fake-grok-access-token-for-tests"
NOW = 1_800_000_000.0


def write_access(home: Path, *, expires_in: float, pushed_ago: float = 60.0) -> None:
    (home / "grok").mkdir(parents=True, exist_ok=True)
    (home / "grok" / "access.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "provider": "xai",
                "access_token": FAKE_TOKEN,
                "expires_at": NOW + expires_in,
                "pushed_at": NOW - pushed_ago,
                "source": "pc-test",
                "account_tag": "abcd1234",
            }
        )
    )


def environ(home: Path, providers: str = "xai") -> dict[str, str]:
    return {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": providers}


def test_child_env_strips_other_credentials_and_sets_the_provider(tmp_path: Path) -> None:
    parent = {
        "PATH": "/usr/bin",
        "HTTPS_PROXY": "http://proxy:3128",
        "HTTP_PROXY": "http://proxy:3128",
        "SF_AUTH_HOME": "/home/sf",
        "XAI_API_KEY": "placeholder",
        "GROK_CODE_XAI_API_KEY": "placeholder",
        "GROK_AUTH": "placeholder",
        "GROK_AUTH_PATH": "/elsewhere/auth.json",
        "GROK_AUTH_PROVIDER_COMMAND": "cat /stolen",
        "GROK_AUTH_PROVIDER_LABEL": "x",
        "GROK_CLI_CHAT_PROXY_BASE_URL": "https://evil.example",
        "XAI_OAUTH_MANAGED": "1",
    }
    env = build_child_env(parent, tmp_path / "grok-home", python="/opt/py/bin/python")
    for name in ("XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_CLI_CHAT_PROXY_BASE_URL"):
        assert name not in env
    assert not [
        name
        for name in env
        if name.startswith("GROK_AUTH") and name != AUTH_PROVIDER_COMMAND_ENV_VAR
    ]
    assert "XAI_OAUTH_MANAGED" not in env
    assert env["GROK_HOME"] == str(tmp_path / "grok-home")
    assert env["GROK_DISABLE_AUTOUPDATER"] == "1"
    assert env["GROK_TELEMETRY_ENABLED"] == "0"
    assert env[AUTH_PROVIDER_COMMAND_ENV_VAR].endswith(
        "/opt/py/bin/python -m sandbox_runtime.harness.grok_auth"
    )
    assert env["HTTPS_PROXY"] == env["HTTP_PROXY"] == "http://proxy:3128"
    assert env["SF_AUTH_HOME"] == "/home/sf"
    assert parent["XAI_API_KEY"] == "placeholder"  # the parent is untouched


def test_config_toml_disables_updates_and_telemetry_and_registers_oi(tmp_path: Path) -> None:
    tool_config = tmp_path / "cfg" / "oi-tools.json"
    parsed = tomllib.loads(config_toml(tool_config, python="/opt/py/bin/python"))
    assert parsed["cli"] == {"auto_update": False}
    assert parsed["features"] == {"telemetry": False}
    server = parsed["mcp_servers"]["oi"]
    assert server["command"] == "/opt/py/bin/python"
    assert server["args"] == ["-m", "sandbox_runtime.harness.codex_tools", str(tool_config)]
    assert set(server["env"]) == {"PYTHONPATH"}
    assert server["tool_timeout_sec"] == 420
    assert "mcp_servers" not in tomllib.loads(config_toml(None))


def test_write_config_makes_a_private_home(tmp_path: Path) -> None:
    home = tmp_path / "grok" / "home"
    path = write_config(home, None)
    assert path == home / "config.toml"
    assert (home.stat().st_mode & 0o777) == 0o700
    assert tomllib.loads(path.read_text())["cli"]["auto_update"] is False


def test_require_enrolled_home(tmp_path: Path) -> None:
    with pytest.raises(HarnessStartError, match="none is mounted"):
        require_enrolled_home({})
    with pytest.raises(HarnessStartError, match="SuperGrok not enrolled for this home"):
        require_enrolled_home(environ(tmp_path, "anthropic,openai"))
    assert require_enrolled_home(environ(tmp_path, "openai, xai")) == tmp_path


def test_preflight_reads_a_fresh_token(tmp_path: Path) -> None:
    write_access(tmp_path, expires_in=3600)
    token = preflight(environ(tmp_path), now=NOW)
    assert token.account_tag == "abcd1234"
    assert FAKE_TOKEN not in repr(token)


def test_preflight_names_a_stale_push_without_the_token(tmp_path: Path) -> None:
    write_access(tmp_path, expires_in=300, pushed_ago=7200)
    with pytest.raises(HarnessStartError) as raised:
        preflight(environ(tmp_path), now=NOW)
    message = str(raised.value)
    assert "SuperGrok credential push stale since" in message
    assert "sf-cred-push.timer on pc-test" in message
    assert FAKE_TOKEN not in message


def test_preflight_missing_file(tmp_path: Path) -> None:
    with pytest.raises(HarnessStartError, match=r"grok/access\.json missing"):
        preflight(environ(tmp_path), now=NOW)


# --- grok_auth -------------------------------------------------------------


def test_grok_auth_prints_the_token_with_a_shortened_lifetime(tmp_path: Path) -> None:
    write_access(tmp_path, expires_in=3600)
    out, err = io.StringIO(), io.StringIO()
    assert grok_auth.main([], environ=environ(tmp_path), stdout=out, stderr=err, now=NOW) == 0
    payload = json.loads(out.getvalue())
    assert payload == {"access_token": FAKE_TOKEN, "expires_in": 3600 - 120}
    assert err.getvalue() == ""


def test_grok_auth_never_reports_a_negative_lifetime(tmp_path: Path) -> None:
    write_access(tmp_path, expires_in=150)
    out = io.StringIO()
    assert (
        grok_auth.main([], environ=environ(tmp_path), stdout=out, stderr=io.StringIO(), now=NOW)
        == 0
    )
    assert json.loads(out.getvalue())["expires_in"] == 30


def test_grok_auth_exits_1_when_stale(tmp_path: Path) -> None:
    write_access(tmp_path, expires_in=100, pushed_ago=9000)
    out, err = io.StringIO(), io.StringIO()
    assert grok_auth.main([], environ=environ(tmp_path), stdout=out, stderr=err, now=NOW) == 1
    assert out.getvalue() == ""
    error = json.loads(err.getvalue())["error"]
    assert "credential push stale since" in error
    assert FAKE_TOKEN not in err.getvalue()


def test_grok_auth_as_grok_runs_it(tmp_path: Path) -> None:
    """The exact command the child env carries, through ``sh -c`` as grok runs it."""
    now = time.time()
    (tmp_path / "grok").mkdir()
    (tmp_path / "grok" / "access.json").write_text(
        json.dumps(
            {"schema": 1, "access_token": FAKE_TOKEN, "expires_at": now + 3600, "pushed_at": now}
        )
    )
    env = build_child_env(
        {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), **environ(tmp_path)},
        tmp_path / "grok-home",
        python=sys.executable,
    )
    result = subprocess.run(
        ["sh", "-c", env[AUTH_PROVIDER_COMMAND_ENV_VAR]],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["access_token"] == FAKE_TOKEN
    assert 3400 < payload["expires_in"] <= 3600 - 120
