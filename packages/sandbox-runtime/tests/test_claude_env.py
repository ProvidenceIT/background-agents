"""The clean-credential launch: the child sees the sandbox environment minus the other mode's credentials."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from sandbox_runtime.harness.claude_env import (
    API_KEY_CREDENTIAL_VARS,
    AUTH_HOME_TOKEN_MISSING,
    BASH_DEFAULT_TIMEOUT_ENV_VAR,
    BASH_MAX_TIMEOUT_ENV_VAR,
    CLAUDE_POLICY_SETTINGS,
    CLI_BASH_MAX_TIMEOUT_SECONDS,
    OAUTH_CREDENTIAL_VARS,
    POOL_PICK_FILE,
    STREAM_SILENCE_MARGIN_SECONDS,
    ClaudeAuthMode,
    ClaudeCredential,
    auth_home_claude_token_file,
    bash_timeout_ceiling_seconds,
    clean_child_env,
    clear_pool_pick,
    denylist_for,
    harness_env,
    read_pool_pick_slot,
    stream_silence_budget_seconds,
    write_clean_env_wrapper,
)

FAKE_BINARY = """#!{python}
import json, os, sys
print(json.dumps({{"env": dict(os.environ), "argv": sys.argv[1:]}}))
"""


def _fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "fake-claude"
    binary.write_text(FAKE_BINARY.format(python=sys.executable))
    binary.chmod(0o755)
    return binary


def _run_wrapper(wrapper: Path, parent_env: dict[str, str], *args: str) -> dict:
    completed = subprocess.run(
        [str(wrapper), *args],
        env=parent_env,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    result = json.loads(completed.stdout)
    # The interpreter running the fake binary adds these itself (C-locale
    # coercion, macOS CoreFoundation); they are not part of what the wrapper
    # forwards, so they are dropped unless the caller supplied them.
    for artifact in ("LC_CTYPE", "__CF_USER_TEXT_ENCODING"):
        if artifact not in parent_env:
            result["env"].pop(artifact, None)
    return result


def _polluted_parent_env(**overrides: str) -> dict[str, str]:
    """The bridge's real inheritance: platform key, sandbox token, user secrets."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": "/root",
        "ANTHROPIC_API_KEY": "sk-ant-platform-key",
        "SANDBOX_AUTH_TOKEN": "sandbox-secret",
        "CONTROL_PLANE_URL": "https://cp.example",
        "SESSION_CONFIG": '{"session_id":"s1"}',
        "DB_PASSWORD": "user-secret",
        "OPENAI_API_KEY": "sk-openai",
        "CLAUDECODE": "1",
        **overrides,
    }


class TestSentinel:
    """The design's sentinel: the child's environment is the parent's minus the other credential family."""

    def test_oauth_mode_strips_the_platform_api_key_and_nothing_else(self, tmp_path: Path) -> None:
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin", mode=ClaudeAuthMode.OAUTH_TOKEN, binary=_fake_binary(tmp_path)
        )
        # What the SDK builds: os.environ merged under options.env.
        parent = _polluted_parent_env(ANTHROPIC_BASE_URL="https://gateway.example")
        options_env = harness_env(tmp_path / "cfg", ClaudeCredential.oauth_token("sk-ant-oat01-x"))
        child = _run_wrapper(wrapper, {**parent, **options_env}, "-v")["env"]

        expected = clean_child_env(parent, ClaudeAuthMode.OAUTH_TOKEN, options_env)
        assert child == expected
        for stripped in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
            assert stripped not in child
        assert child["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-x"
        # Parity with OpenCode: the sandbox helpers (oi-git-sign, oi-git-credentials,
        # upload-media) and the agent's commands need the session context and secrets.
        assert child["SANDBOX_AUTH_TOKEN"] == parent["SANDBOX_AUTH_TOKEN"]
        assert child["SESSION_CONFIG"] == parent["SESSION_CONFIG"]
        assert child["CONTROL_PLANE_URL"] == parent["CONTROL_PLANE_URL"]
        assert child["DB_PASSWORD"] == "user-secret"
        assert child["OPENAI_API_KEY"] == "sk-openai"

    def test_api_key_mode_forwards_the_key_family_and_strips_the_oauth_token(
        self, tmp_path: Path
    ) -> None:
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin", mode=ClaudeAuthMode.API_KEY, binary=_fake_binary(tmp_path)
        )
        parent = _polluted_parent_env(
            ANTHROPIC_BASE_URL="https://gateway.example",
            CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-stray",
        )
        credential = ClaudeCredential.api_key(parent)
        assert credential is not None
        options_env = harness_env(tmp_path / "cfg", credential)
        child = _run_wrapper(wrapper, {**parent, **options_env})["env"]

        assert child == clean_child_env(parent, ClaudeAuthMode.API_KEY, options_env)
        assert child["ANTHROPIC_API_KEY"] == "sk-ant-platform-key"
        assert child["ANTHROPIC_BASE_URL"] == "https://gateway.example"
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in child
        assert child["SANDBOX_AUTH_TOKEN"] == parent["SANDBOX_AUTH_TOKEN"]

    def test_wrapper_forwards_arguments_including_the_version_probe(self, tmp_path: Path) -> None:
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin", mode=ClaudeAuthMode.OAUTH_TOKEN, binary=_fake_binary(tmp_path)
        )
        result = _run_wrapper(wrapper, _polluted_parent_env(), "-v")
        assert result["argv"] == ["-v"]

    def test_wrapper_carries_names_not_values(self, tmp_path: Path) -> None:
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin", mode=ClaudeAuthMode.OAUTH_TOKEN, binary=_fake_binary(tmp_path)
        )
        text = wrapper.read_text()
        # The script names what it strips, never what it forwards, and no value.
        assert "ANTHROPIC_API_KEY" in text
        assert "sk-ant" not in text


class TestAuthHome:
    """The subscription home: the wrapper reads the subscriber's token from the mount at exec."""

    TOKEN = "sk-ant-oat01-subscriber-token"

    def _home(self, tmp_path: Path, token: str | None = TOKEN) -> Path:
        home = tmp_path / "sf-auth"
        (home / "claude").mkdir(parents=True)
        (home / "codex").mkdir()
        (home / "codex" / "auth.json").write_text("{}")
        if token is not None:
            (home / "claude" / "oauth-token").write_text(token + "\n")
        return home

    def _wrapper(self, tmp_path: Path, home: Path) -> Path:
        credential = ClaudeCredential.auth_home(home / "claude" / "oauth-token")
        assert credential.mode is ClaudeAuthMode.AUTH_HOME
        assert dict(credential.env) == {}
        return write_clean_env_wrapper(
            tmp_path / "bin",
            mode=credential.mode,
            binary=_fake_binary(tmp_path),
            token_file=credential.token_file,
        )

    def test_the_child_gets_the_file_token_and_no_api_key(self, tmp_path: Path) -> None:
        home = self._home(tmp_path)
        wrapper = self._wrapper(tmp_path, home)
        parent = _polluted_parent_env(
            ANTHROPIC_BASE_URL="https://gateway.example",
            CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-stray",
            SF_AUTH_HOME=str(home),
            SF_AUTH_HOME_PROVIDERS="anthropic",
        )
        options_env = harness_env(tmp_path / "cfg", ClaudeCredential.auth_home(home))
        result = _run_wrapper(wrapper, {**parent, **options_env}, "--print", "--bare", "-v")
        child = result["env"]

        assert child["CLAUDE_CODE_OAUTH_TOKEN"] == self.TOKEN
        for stripped in API_KEY_CREDENTIAL_VARS:
            assert stripped not in child
        expected = clean_child_env(parent, ClaudeAuthMode.AUTH_HOME, options_env)
        assert child == {**expected, "CLAUDE_CODE_OAUTH_TOKEN": self.TOKEN}
        assert result["argv"] == ["--print", "-v"]

    def test_a_rotated_token_reaches_the_next_child(self, tmp_path: Path) -> None:
        home = self._home(tmp_path)
        wrapper = self._wrapper(tmp_path, home)
        (home / "claude" / "oauth-token").write_text("sk-ant-oat01-rotated")
        child = _run_wrapper(wrapper, _polluted_parent_env())["env"]
        assert child["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-rotated"

    def test_the_wrapper_names_the_file_never_the_token(self, tmp_path: Path) -> None:
        home = self._home(tmp_path)
        text = self._wrapper(tmp_path, home).read_text()
        assert str(home / "claude" / "oauth-token") in text
        assert "sk-ant" not in text
        assert "--bare" in text

    def test_a_missing_or_empty_token_stops_the_child_without_saying_more(
        self, tmp_path: Path
    ) -> None:
        for token in (None, "  \n"):
            case = tmp_path / ("missing" if token is None else "empty")
            home = self._home(case, token)
            wrapper = self._wrapper(case, home)
            completed = subprocess.run(
                [str(wrapper), "-v"],
                env=_polluted_parent_env(),
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert completed.returncode == 78
            assert completed.stdout == ""
            assert completed.stderr == AUTH_HOME_TOKEN_MISSING + "\n"
            assert "codex" not in completed.stderr
            assert "sk-ant" not in completed.stderr

    def test_auth_home_mode_needs_a_token_file(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="token file"):
            write_clean_env_wrapper(
                tmp_path / "bin", mode=ClaudeAuthMode.AUTH_HOME, binary=_fake_binary(tmp_path)
            )

    def test_the_token_file_is_found_only_for_an_anthropic_home(self) -> None:
        assert auth_home_claude_token_file({}) is None
        assert (
            auth_home_claude_token_file(
                {"SF_AUTH_HOME": "/home/sandbox/.sf-auth", "SF_AUTH_HOME_PROVIDERS": "openai"}
            )
            is None
        )
        assert auth_home_claude_token_file(
            {"SF_AUTH_HOME": "/home/sandbox/.sf-auth", "SF_AUTH_HOME_PROVIDERS": "openai,anthropic"}
        ) == Path("/home/sandbox/.sf-auth/claude/oauth-token")


class TestDenylist:
    def test_modes_are_mutually_exclusive(self) -> None:
        assert set(API_KEY_CREDENTIAL_VARS).isdisjoint(OAUTH_CREDENTIAL_VARS)
        assert denylist_for(ClaudeAuthMode.OAUTH_TOKEN) == API_KEY_CREDENTIAL_VARS
        assert denylist_for(ClaudeAuthMode.API_KEY) == OAUTH_CREDENTIAL_VARS
        assert denylist_for(ClaudeAuthMode.AUTH_HOME) == API_KEY_CREDENTIAL_VARS

    def test_only_anthropic_credentials_are_ever_stripped(self) -> None:
        stripped = set(API_KEY_CREDENTIAL_VARS) | set(OAUTH_CREDENTIAL_VARS)
        assert all(name.startswith(("ANTHROPIC_", "CLAUDE_CODE_OAUTH_")) for name in stripped)
        for needed in ("SANDBOX_AUTH_TOKEN", "SESSION_CONFIG", "CONTROL_PLANE_URL", "PATH"):
            assert needed not in stripped

    def test_api_key_credential_requires_the_key(self) -> None:
        assert ClaudeCredential.api_key({"ANTHROPIC_BASE_URL": "x"}) is None
        credential = ClaudeCredential.api_key(
            {"ANTHROPIC_API_KEY": "k", "ANTHROPIC_AUTH_TOKEN": "t"}
        )
        assert credential is not None
        assert dict(credential.env) == {"ANTHROPIC_API_KEY": "k", "ANTHROPIC_AUTH_TOKEN": "t"}

    def test_harness_env_keeps_sub_agents_in_the_foreground(self, tmp_path: Path) -> None:
        # A background sub-agent would let the turn end before its work is done
        # and deliver its result on a turn the harness never reads.
        env = harness_env(tmp_path, ClaudeCredential.oauth_token("tok"))
        assert env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] == "1"

    def test_harness_env_disables_file_based_auto_memory(self, tmp_path: Path) -> None:
        # Auto memory would add a competing memory system to the system prompt.
        env = harness_env(tmp_path, ClaudeCredential.oauth_token("tok"))
        assert env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"

    def test_harness_env_sets_config_dir_and_policy(self, tmp_path: Path) -> None:
        env = harness_env(tmp_path, ClaudeCredential.oauth_token("tok"))
        assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path)
        assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
        assert env["DISABLE_ERROR_REPORTING"] == "1"
        assert env["DISABLE_TELEMETRY"] == "1"
        assert env["CLAUDE_CODE_ENABLE_TELEMETRY"] == "0"
        assert env["OTEL_METRICS_EXPORTER"] == "none"
        assert env["OTEL_LOGS_EXPORTER"] == "none"
        assert env["OTEL_TRACES_EXPORTER"] == "none"
        assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "tok"

    def test_policy_settings_disable_attribution_and_feedback(self) -> None:
        assert json.loads(CLAUDE_POLICY_SETTINGS) == {
            "attribution": {"commit": "", "pr": "", "sessionUrl": False},
            "feedbackDrafts": "off",
            "feedbackSurveyRate": 0,
        }


class TestBashTimeoutCeiling:
    """The ceiling the child enforces, which is how long the stream may be silent."""

    def test_the_cli_builtin_applies_when_the_environment_says_nothing(self) -> None:
        assert bash_timeout_ceiling_seconds({}) == CLI_BASH_MAX_TIMEOUT_SECONDS

    def test_the_environment_raises_it(self) -> None:
        assert bash_timeout_ceiling_seconds({BASH_MAX_TIMEOUT_ENV_VAR: "1200000"}) == 1200.0

    def test_a_default_above_the_max_wins_as_the_cli_does(self) -> None:
        """The CLI takes the larger of the two, so a raised default is a ceiling too."""
        environ = {BASH_MAX_TIMEOUT_ENV_VAR: "60000", BASH_DEFAULT_TIMEOUT_ENV_VAR: "900000"}
        assert bash_timeout_ceiling_seconds(environ) == 900.0

    def test_the_environment_can_lower_it(self) -> None:
        assert bash_timeout_ceiling_seconds({BASH_MAX_TIMEOUT_ENV_VAR: "60000"}) == 120.0

    def test_values_the_cli_ignores_are_ignored_here_too(self) -> None:
        for raw in ("", "soon", "0", "-1", "nan", "inf"):
            environ = {BASH_MAX_TIMEOUT_ENV_VAR: raw}
            assert bash_timeout_ceiling_seconds(environ) == CLI_BASH_MAX_TIMEOUT_SECONDS

    def test_the_budget_clears_the_ceiling_by_the_margin(self) -> None:
        environ = {BASH_MAX_TIMEOUT_ENV_VAR: "1200000"}
        assert stream_silence_budget_seconds(environ) == 1200.0 + STREAM_SILENCE_MARGIN_SECONDS

    def test_the_child_really_receives_the_ceiling_the_budget_was_resolved_from(
        self, tmp_path: Path
    ) -> None:
        """The two layers agree only because the wrapper forwards the variable:
        the bridge resolves the ceiling from its own environment, and this is
        the environment the child is launched with.
        """
        parent = _polluted_parent_env(**{BASH_MAX_TIMEOUT_ENV_VAR: "1200000"})
        wrapper = write_clean_env_wrapper(
            tmp_path / "bin", mode=ClaudeAuthMode.API_KEY, binary=_fake_binary(tmp_path)
        )

        child_env = _run_wrapper(wrapper, parent)["env"]

        assert child_env[BASH_MAX_TIMEOUT_ENV_VAR] == "1200000"
        assert bash_timeout_ceiling_seconds(child_env) == bash_timeout_ceiling_seconds(parent)


class TestPoolPick:
    def test_reads_only_a_well_formed_slot_name(self, tmp_path: Path) -> None:
        pick = tmp_path / POOL_PICK_FILE
        assert read_pool_pick_slot(tmp_path) is None
        pick.write_text(json.dumps({"slot": "claude-3", "reason": "ranked"}))
        assert read_pool_pick_slot(tmp_path) == "claude-3"
        for junk in ("not json", json.dumps({"slot": "../x"}), json.dumps({"slot": 3}), "[]"):
            pick.write_text(junk)
            assert read_pool_pick_slot(tmp_path) is None

    def test_clearing_forgets_the_previous_child(self, tmp_path: Path) -> None:
        (tmp_path / POOL_PICK_FILE).write_text(json.dumps({"slot": "claude-1"}))
        clear_pool_pick(tmp_path)
        clear_pool_pick(tmp_path)
        assert read_pool_pick_slot(tmp_path) is None
