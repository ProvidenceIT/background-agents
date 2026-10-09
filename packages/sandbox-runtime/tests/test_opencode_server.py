"""OpenCode's process env: what a mounted subscription home contributes."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.opencode_server import (
    AUTH_HOME_ENV_ALLOWLIST,
    OpenCodeServer,
    parse_auth_home_env,
)
from tests.runtime_helpers import make_opencode_server


def _server() -> OpenCodeServer:
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
        },
    ):
        return make_opencode_server()


async def _process_env(tmp_path: Path, environ: dict[str, str]) -> dict[str, str]:
    """Start OpenCode with a fake process and return the env it was given."""
    sup = _server()
    sup.workspace_path = tmp_path / "workspace"
    sup.workspace_path.mkdir(parents=True)
    sup._setup_managed_oauth = MagicMock()
    sup._install_tools = MagicMock()
    sup._install_skills = MagicMock()
    sup._wait_for_health = AsyncMock()
    fake_proc = MagicMock()
    fake_proc.stdout = None
    spawn = AsyncMock(return_value=fake_proc)
    with (
        patch.dict("os.environ", environ, clear=True),
        patch("sandbox_runtime.opencode_server.asyncio.create_subprocess_exec", spawn),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
        patch("sandbox_runtime.opencode_server.install_bin_scripts"),
    ):
        await sup.start((), sup.workspace_path)
    return spawn.call_args.kwargs["env"]


def _home(tmp_path: Path, env_text: str | None) -> Path:
    home = tmp_path / "sf-auth"
    home.mkdir()
    if env_text is not None:
        (home / "env").write_text(env_text)
    return home


@pytest.mark.asyncio
async def test_the_home_env_file_exports_only_allowlisted_keys(tmp_path: Path) -> None:
    home = _home(tmp_path, "ZHIPU_API_KEY=glm-placeholder\nFOO=bar\nPATH=/evil\n")
    env = await _process_env(
        tmp_path, {"PATH": "/usr/bin", "SF_AUTH_HOME": str(home), "SF_AUTH_HOME_PROVIDERS": "zai"}
    )
    assert env["ZHIPU_API_KEY"] == "glm-placeholder"
    assert "FOO" not in env
    assert env["PATH"] == "/usr/bin"


@pytest.mark.asyncio
async def test_no_home_or_no_file_adds_nothing(tmp_path: Path) -> None:
    without = await _process_env(tmp_path / "a", {"PATH": "/usr/bin"})
    home = _home(tmp_path, None)
    empty_home = await _process_env(tmp_path / "b", {"PATH": "/usr/bin", "SF_AUTH_HOME": str(home)})
    for env in (without, empty_home):
        assert not AUTH_HOME_ENV_ALLOWLIST & set(env)


def test_the_parser_reads_assignments_and_executes_nothing() -> None:
    text = "\n".join(
        [
            "# the owner's keys",
            "",
            "export XAI_API_KEY='xai-placeholder'",
            'DEEPSEEK_API_KEY="ds-placeholder"',
            "OPENCODE_API_KEY=first",
            "OPENCODE_API_KEY=second",
            "ZHIPU_API_KEY=",
            "ANTHROPIC_API_KEY=must-not-pass",
            "ZHIPU_API_KEY$(touch /tmp/x)=x",
            "not an assignment",
        ]
    )
    assert parse_auth_home_env(text) == {
        "XAI_API_KEY": "xai-placeholder",
        "DEEPSEEK_API_KEY": "ds-placeholder",
        "OPENCODE_API_KEY": "second",
    }


def test_the_allowlist_is_exactly_the_four_provider_keys() -> None:
    assert (
        frozenset({"ZHIPU_API_KEY", "OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY"})
        == AUTH_HOME_ENV_ALLOWLIST
    )


def test_sourcing_logs_names_never_values(tmp_path: Path) -> None:
    home = _home(tmp_path, "ZHIPU_API_KEY=glm-placeholder\n")
    sup = _server()
    sup.log = MagicMock()
    with patch.dict("os.environ", {"SF_AUTH_HOME": str(home)}, clear=True):
        assert sup._source_auth_home_env() == {"ZHIPU_API_KEY": "glm-placeholder"}
    sup.log.info.assert_called_once_with("auth_home.env_sourced", keys=["ZHIPU_API_KEY"])
    assert "glm-placeholder" not in repr(sup.log.mock_calls)
