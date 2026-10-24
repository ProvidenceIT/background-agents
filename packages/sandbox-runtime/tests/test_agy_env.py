"""agy_env: the child's environment, its access-only token file and its MCP config."""

from __future__ import annotations

import json
import stat
import sys
import time
from pathlib import Path

import pytest

from sandbox_runtime import pushed_token
from sandbox_runtime.harness import HarnessStartError, agy_env
from sandbox_runtime.harness.codex_tools import TOOL_SERVER_MODULE
from sandbox_runtime.pushed_token import PushedToken

FAKE_ACCESS = "fake-access-token-not-real"


def token(expires_in: float = 3000.0) -> PushedToken:
    return PushedToken(
        cli="agy",
        access_token=FAKE_ACCESS,
        expires_at=time.time() + expires_in,
        pushed_at=time.time() - 30,
        source="pc-test",
        account_tag="abcd1234",
    )


def push(home: Path, expires_in: float) -> None:
    (home / "agy").mkdir(parents=True, exist_ok=True)
    (home / "agy" / "access.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "provider": "antigravity",
                "access_token": FAKE_ACCESS,
                "expires_at": time.time() + expires_in,
                "pushed_at": 1_790_000_000,
                "source": "pc-test",
                "account_tag": "abcd1234",
            }
        )
    )


class TestChildEnv:
    def test_strips_google_credentials_and_the_desktop(self, tmp_path: Path):
        parent = {
            "PATH": "/usr/bin",
            "HOME": "/elsewhere",
            "GEMINI_API_KEY": "placeholder",
            "GOOGLE_API_KEY": "placeholder",
            "GOOGLE_APPLICATION_CREDENTIALS": "/x.json",
            "GOOGLE_CLOUD_PROJECT": "proj",
            "AGY_LLM_GATEWAY_URL": "http://gateway",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/bus",
            "DISPLAY": ":1",
            "HTTPS_PROXY": "http://proxy:3128",
        }
        env = agy_env.child_env(parent, tmp_path)
        for name in (
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "AGY_LLM_GATEWAY_URL",
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
        ):
            assert name not in env
        assert env["HOME"] == str(tmp_path)
        assert env["BROWSER"] == "/bin/false"
        assert env["AGY_CLI_DISABLE_AUTO_UPDATE"] == "1"
        assert env["HTTPS_PROXY"] == "http://proxy:3128"
        assert parent["DISPLAY"] == ":1"  # the parent is untouched


class TestTokenFile:
    def test_is_access_only_and_private(self, tmp_path: Path):
        path = agy_env.write_token(tmp_path, token(1800))
        assert path == tmp_path / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        payload = json.loads(path.read_text())
        assert payload["auth_method"] == "consumer"
        assert set(payload) == {"token", "auth_method"}
        assert set(payload["token"]) == {"access_token", "token_type", "expiry", "expires_in"}
        assert payload["token"]["access_token"] == FAKE_ACCESS
        assert payload["token"]["token_type"] == "Bearer"
        assert payload["token"]["expiry"].endswith("Z")
        assert 1790 <= payload["token"]["expires_in"] <= 1800

    def test_a_refresh_token_in_the_push_never_reaches_agy(self, tmp_path: Path):
        # Egress cannot keep a pod from refreshing (www.googleapis.com serves a token
        # endpoint too); what keeps it from refreshing is that no refresh token is here.
        push(tmp_path, 3000)
        access = tmp_path / "agy" / "access.json"
        raw = json.loads(access.read_text())
        raw.update(refresh_token="placeholder-refresh-token", id_token="placeholder-id-token")
        access.write_text(json.dumps(raw))
        pushed = pushed_token.read_file(access, "agy")
        path = agy_env.write_token(tmp_path / "home", pushed)
        text = path.read_text()
        assert "refresh_token" not in text and "id_token" not in text
        assert "placeholder-refresh-token" not in text and "placeholder-id-token" not in text

    def test_rewrite_replaces_the_file_and_leaves_no_temp(self, tmp_path: Path):
        agy_env.write_token(tmp_path, token(1000))
        agy_env.write_token(tmp_path, token(3000))
        directory = tmp_path / ".gemini" / "antigravity-cli"
        assert [p.name for p in directory.iterdir()] == ["antigravity-oauth-token"]
        payload = json.loads((directory / "antigravity-oauth-token").read_text())
        assert payload["token"]["expires_in"] > 2900


class TestMcpConfig:
    def test_registers_the_oi_server_in_the_shape_agy_mcp_add_writes(self, tmp_path: Path):
        tool_config = tmp_path / "cfg" / "oi-tools.json"
        path = agy_env.write_mcp_config(tmp_path, tool_config)
        assert path == tmp_path / ".gemini" / "config" / "mcp_config.json"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        payload = json.loads(path.read_text())
        assert list(payload) == ["mcpServers"]
        assert list(payload["mcpServers"]) == ["oi"]
        server = payload["mcpServers"]["oi"]
        assert server["command"] == sys.executable
        assert server["args"] == ["-m", TOOL_SERVER_MODULE, str(tool_config)]
        assert server["disabled"] is False
        assert Path(server["env"]["PYTHONPATH"], "sandbox_runtime").is_dir()

    def test_without_tools_no_server_is_registered(self, tmp_path: Path):
        path = agy_env.write_mcp_config(tmp_path, None)
        assert json.loads(path.read_text()) == {"mcpServers": {}}


class TestPreflight:
    def environ(self, home: Path, providers: str = "antigravity") -> dict[str, str]:
        return {"SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": providers}

    def test_returns_a_fresh_token(self, tmp_path: Path):
        push(tmp_path, 3000)
        assert agy_env.preflight(self.environ(tmp_path)).access_token == FAKE_ACCESS

    def test_under_ten_minutes_left_is_the_named_stale_push(self, tmp_path: Path):
        push(tmp_path, 590)
        with pytest.raises(HarnessStartError) as error:
            agy_env.preflight(self.environ(tmp_path))
        message = str(error.value)
        assert "Antigravity credential push stale since" in message
        assert "check sf-cred-push.timer on pc-test" in message
        assert FAKE_ACCESS not in message

    def test_a_home_without_antigravity_is_refused(self, tmp_path: Path):
        push(tmp_path, 3000)
        with pytest.raises(HarnessStartError, match="not enrolled"):
            agy_env.preflight(self.environ(tmp_path, providers="anthropic"))

    def test_a_missing_push_is_refused(self, tmp_path: Path):
        with pytest.raises(HarnessStartError, match=r"agy/access\.json missing"):
            agy_env.preflight(self.environ(tmp_path))


class TestConversationExists:
    def test_only_a_uuid_with_its_database_exists(self, tmp_path: Path):
        conversation = "11111111-2222-4333-8444-555555555555"
        directory = tmp_path / ".gemini" / "antigravity-cli" / "conversations"
        directory.mkdir(parents=True)
        assert not agy_env.conversation_exists(tmp_path, conversation)
        (directory / f"{conversation}.db").write_bytes(b"")
        assert agy_env.conversation_exists(tmp_path, conversation)
        assert not agy_env.conversation_exists(tmp_path, "../../etc/passwd")
