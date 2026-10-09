"""The Codex harness in the runtime's registries, budgets, stager and tool server."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from sandbox_runtime.codex_stager import CodexHarnessHandoff, CodexStager
from sandbox_runtime.entrypoint import build_harness_process, harness_config_dir
from sandbox_runtime.harness import BridgeIdentity, build_agent_harness
from sandbox_runtime.harness.base import HarnessId, PromptLimits, parse_harness_id
from sandbox_runtime.harness.claude_tools import ToolServerConfig
from sandbox_runtime.harness.codex import CodexHarness
from sandbox_runtime.harness.codex_tools import write_tool_config
from sandbox_runtime.prompt_budgets import CODEX_INACTIVITY_TIMEOUT_SECONDS, resolve_prompt_limits
from tests.runtime_helpers import make_runtime_config


def test_codex_is_a_harness_id():
    assert parse_harness_id("codex") is HarnessId.CODEX


def test_the_registry_builds_codex_from_the_handoff_with_memory_and_tools(tmp_path: Path):
    config_dir = tmp_path / "codex-config"
    config_dir.mkdir()
    (config_dir / "oi-memory.md").write_text("# Memory\n\nA pinned directive\n")
    handoff = CodexHarnessHandoff(tmp_path / "workspace", config_dir, True)
    with (
        patch("sandbox_runtime.harness.CodexHarnessHandoff.read", return_value=handoff),
        patch.dict("os.environ", {"SESSION_CONFIG": json.dumps({"model": "openai/gpt-6-luna"})}),
    ):
        harness = build_agent_harness(
            HarnessId.CODEX,
            identity=BridgeIdentity(
                "sandbox", "session-1", "https://control.test", "token", tmp_path / "repos.json"
            ),
            attachment_processor=MagicMock(),
            log=MagicMock(),
            limits=PromptLimits(60, 120, 10),
            opencode_port=4096,
        )

    assert isinstance(harness, CodexHarness)
    assert harness.config.workdir == tmp_path / "workspace"
    assert harness.config.default_model == "openai/gpt-6-luna"
    assert harness.config.developer_instructions == "# Memory\n\nA pinned directive\n"
    assert harness.config.tools is not None
    assert harness.config.tools.session_id == "session-1"
    assert harness.config.tools.has_repository is True


def test_the_supervisor_stages_codex_without_a_resident_process():
    config = make_runtime_config({"SESSION_CONFIG": json.dumps({"harness": "codex"})})
    owner = build_harness_process(config, MagicMock(), MagicMock(), MagicMock(), None)
    assert isinstance(owner, CodexStager)
    assert owner.exit_code() is None


def test_codex_keeps_its_config_outside_the_subscription_home():
    assert harness_config_dir(HarnessId.CODEX, None) == Path.home() / ".openinspect/codex"


def test_codex_waits_out_a_long_command_before_calling_it_silence(monkeypatch):
    monkeypatch.delenv("BRIDGE_SSE_INACTIVITY_TIMEOUT", raising=False)
    limits = resolve_prompt_limits(MagicMock(), HarnessId.CODEX)
    assert limits.inactivity_timeout_seconds == CODEX_INACTIVITY_TIMEOUT_SECONDS == 1200.0


async def test_the_stager_writes_the_handoff(tmp_path: Path):
    handoff_path = tmp_path / "handoff.json"
    stager = CodexStager(False, MagicMock(), config_dir=tmp_path / "cfg", handoff_path=handoff_path)
    with patch("sandbox_runtime.codex_stager.install_bin_scripts") as install:
        await stager.start((), tmp_path / "workspace")

    install.assert_called_once()
    assert (tmp_path / "cfg").is_dir()
    assert CodexHarnessHandoff.read(handoff_path) == CodexHarnessHandoff(
        tmp_path / "workspace", tmp_path / "cfg", False
    )


async def test_the_tool_server_answers_mcp_over_stdio(tmp_path: Path):
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    path = write_tool_config(
        ToolServerConfig(
            control_plane_url="https://control.test",
            session_id="session-1",
            auth_token="placeholder-token",
            repo_manifest_path=tmp_path / "repos.json",
            has_repository=True,
            slack_notify_enabled=False,
        ),
        tmp_path,
    )
    package_root = str(Path(__file__).resolve().parents[1] / "src")
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "sandbox_runtime.harness.codex_tools", str(path)],
        env={"PYTHONPATH": package_root},
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        listed = await session.list_tools()

    names = {tool.name for tool in listed.tools}
    assert {"spawn-child", "create-pull-request", "memory_read", "memory_search"} <= names
