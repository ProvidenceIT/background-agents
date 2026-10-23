"""The grok and agy harnesses in the runtime's registries, stager, budgets and manifest.

The end-to-end cases stage a sandbox with ``CliStager``, build the harness
through ``build_agent_harness`` from a fake ``SESSION_CONFIG``, and run one
turn against the fake CLIs the harness tests use (found on ``PATH`` by name,
as in a pod).
"""

from __future__ import annotations

import dataclasses
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from sandbox_runtime.cli_stager import CliHarnessHandoff, CliStager, cli_layout
from sandbox_runtime.entrypoint import (
    build_harness_process,
    harness_config_dir,
    managed_skills_destination,
)
from sandbox_runtime.harness import BridgeIdentity, HarnessPrompt, build_agent_harness
from sandbox_runtime.harness.agy import AgyHarness
from sandbox_runtime.harness.base import HarnessId, PromptLimits, parse_harness_id
from sandbox_runtime.harness.codex_tools import TOOL_CONFIG_FILE_NAME
from sandbox_runtime.harness.grok import GrokHarness
from sandbox_runtime.prompt_budgets import CODEX_INACTIVITY_TIMEOUT_SECONDS, resolve_prompt_limits
from tests import test_agy_harness, test_grok_harness
from tests.runtime_helpers import make_runtime_config

CLI_HARNESSES = (HarnessId.GROK, HarnessId.AGY)
IDENTITY_TOKEN = "placeholder-sandbox-token"


def identity(tmp_path: Path) -> BridgeIdentity:
    return BridgeIdentity(
        "sandbox", "session-1", "https://control.test", IDENTITY_TOKEN, tmp_path / "repos.json"
    )


def build(
    harness_id: HarnessId, tmp_path: Path, session_config: dict[str, Any], log: Any = None
) -> Any:
    with patch.dict("os.environ", {"SESSION_CONFIG": json.dumps(session_config)}):
        return build_agent_harness(
            harness_id,
            identity=identity(tmp_path),
            attachment_processor=MagicMock(),
            log=log or MagicMock(),
            limits=PromptLimits(60, 120, 10),
            opencode_port=4096,
        )


async def stage(harness_id: HarnessId, home: Path, *, has_repository: bool = True) -> CliStager:
    layout = dataclasses.replace(cli_layout(harness_id, home), handoff_path=home / "handoff.json")
    stager = CliStager(harness_id, has_repository, MagicMock(), layout=layout)
    (home / "workspace").mkdir(parents=True, exist_ok=True)
    with patch("sandbox_runtime.cli_stager.install_bin_scripts") as install:
        await stager.start((), home / "workspace")
    install.assert_called_once()
    return stager


@pytest.mark.parametrize("name", ["grok", "agy"])
def test_grok_and_agy_are_harness_ids(name: str):
    assert parse_harness_id(name) is HarnessId(name)


@pytest.mark.parametrize("harness_id", CLI_HARNESSES)
def test_the_supervisor_stages_without_a_resident_process(harness_id: HarnessId):
    config = make_runtime_config({"SESSION_CONFIG": json.dumps({"harness": harness_id.value})})
    owner = build_harness_process(config, MagicMock(), MagicMock(), MagicMock(), None)
    assert isinstance(owner, CliStager)
    assert owner.harness is harness_id
    assert owner.layout.handoff_path == Path(f"/tmp/oi-{harness_id.value}-harness.json")
    assert owner.exit_code() is None


async def test_the_grok_stager_writes_the_handoff_and_a_private_grok_home(tmp_path: Path):
    stager = await stage(HarnessId.GROK, tmp_path)
    layout = stager.layout
    grok_home = tmp_path / ".openinspect" / "grok" / "home"

    assert CliHarnessHandoff.read(layout.handoff_path) == CliHarnessHandoff(
        tmp_path / "workspace", tmp_path / ".openinspect" / "grok", True, grok_home
    )
    assert json.loads(layout.handoff_path.read_text()).keys() == {
        "workdir",
        "config_dir",
        "has_repository",
        "cli_home",
    }
    assert grok_home.stat().st_mode & 0o777 == 0o700
    config = (grok_home / "config.toml").read_text()
    assert "[cli]\nauto_update = false" in config
    assert "[features]\ntelemetry = false" in config
    assert "[mcp_servers.oi]" in config
    assert json.dumps(str(layout.config_dir / TOOL_CONFIG_FILE_NAME)) in config


async def test_the_agy_stager_registers_the_tools_in_the_sandbox_home(tmp_path: Path):
    stager = await stage(HarnessId.AGY, tmp_path, has_repository=False)
    layout = stager.layout

    assert CliHarnessHandoff.read(layout.handoff_path) == CliHarnessHandoff(
        tmp_path / "workspace", tmp_path / ".openinspect" / "agy", False, tmp_path
    )
    # The home itself is left as it is; only agy's own tree is made private.
    assert (tmp_path / ".gemini").stat().st_mode & 0o777 == 0o700
    mcp = json.loads((tmp_path / ".gemini" / "config" / "mcp_config.json").read_text())
    oi = mcp["mcpServers"]["oi"]
    assert oi["args"][-1] == str(layout.config_dir / TOOL_CONFIG_FILE_NAME)
    assert oi["disabled"] is False


@pytest.mark.parametrize("harness_id", CLI_HARNESSES)
def test_config_dir_is_per_harness_and_never_the_cli_home(harness_id: HarnessId):
    config_dir = harness_config_dir(harness_id, None)
    assert config_dir == Path.home() / ".openinspect" / harness_id.value
    assert config_dir != cli_layout(harness_id).cli_home


def test_managed_skills_go_where_each_cli_discovers_user_skills():
    # GROK_HOME stands in for ~/.grok, whose skills/ grok reads; agy reads
    # ~/.gemini/config/skills (confirmed in the agy live smoke).
    assert managed_skills_destination(HarnessId.GROK, None) == (
        Path.home() / ".openinspect" / "grok" / "home" / "skills"
    )
    assert managed_skills_destination(HarnessId.AGY, None) == (
        Path.home() / ".gemini" / "config" / "skills"
    )


@pytest.mark.parametrize("harness_id", CLI_HARNESSES)
def test_a_long_command_is_not_silence(monkeypatch, harness_id: HarnessId):
    monkeypatch.delenv("BRIDGE_SSE_INACTIVITY_TIMEOUT", raising=False)
    limits = resolve_prompt_limits(MagicMock(), harness_id)
    assert limits.inactivity_timeout_seconds == CODEX_INACTIVITY_TIMEOUT_SECONDS


@pytest.mark.parametrize(
    ("harness_id", "harness_class", "model"),
    [
        (HarnessId.GROK, GrokHarness, "xai/grok-4.7"),
        (HarnessId.AGY, AgyHarness, "antigravity/gemini-3.8-flash"),
    ],
)
async def test_the_registry_builds_from_the_handoff_with_memory_and_tools(
    tmp_path: Path, harness_id: HarnessId, harness_class: type, model: str
):
    stager = await stage(harness_id, tmp_path)
    config_dir = stager.layout.config_dir
    (config_dir / "oi-memory.md").write_text("# Memory\n\nA pinned directive\n")
    log = MagicMock()
    with patch("sandbox_runtime.cli_stager.cli_layout", return_value=stager.layout) as layout_for:
        harness = build(
            harness_id,
            tmp_path,
            {"model": model, "mcp_servers": [{"name": "repo-mcp"}]},
            log,
        )

    layout_for.assert_called_once_with(harness_id)
    assert isinstance(harness, harness_class)
    assert harness.config.workdir == tmp_path / "workspace"
    assert harness.config.config_dir == config_dir
    assert harness.config.cli_home == stager.layout.cli_home
    assert harness.config.default_model == model
    assert harness.config.memory_text == "# Memory\n\nA pinned directive\n"
    tool_config = harness.config.tool_config_path
    assert tool_config == config_dir / TOOL_CONFIG_FILE_NAME
    assert tool_config.stat().st_mode & 0o777 == 0o600
    tools = json.loads(tool_config.read_text())
    assert tools["session_id"] == "session-1"
    assert tools["has_repository"] is True
    log.warn.assert_called_once_with(f"{harness_id.value}.mcp_servers_unsupported", count=1)


@pytest.mark.parametrize(
    ("harness_id", "default_model"),
    [(HarnessId.GROK, "xai/grok-4.7-build-fast"), (HarnessId.AGY, "antigravity/gemini-4-argon")],
)
async def test_without_a_session_model_the_harness_default_applies(
    tmp_path: Path, harness_id: HarnessId, default_model: str
):
    stager = await stage(harness_id, tmp_path)
    log = MagicMock()
    with patch("sandbox_runtime.cli_stager.cli_layout", return_value=stager.layout):
        harness = build(harness_id, tmp_path, {}, log)

    assert harness.config.default_model == default_model
    assert harness.config.memory_text is None
    log.warn.assert_not_called()


def test_the_manifest_floors_grok_and_agy_at_the_current_generation():
    manifest_path = Path(__file__).parents[1] / "src" / "sandbox_runtime" / "runtime_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["generation"] == 75
    assert manifest["runtimeVersion"].startswith("v75-")
    assert manifest["harnessMinimumGeneration"]["grok"] == 75
    assert manifest["harnessMinimumGeneration"]["agy"] == 75


# --- one turn, end to end, against the fake CLIs -----------------------------


async def run_one_turn(harness: Any, model: str) -> tuple[Any, list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    await harness.open()
    await harness.create_session()
    try:
        outcome = await harness.run_prompt(
            HarnessPrompt(message_id="msg-1", text="Reply with PONG", model=model), emit
        )
    finally:
        await harness.close()
    return outcome, events


def fake_cli_environ(rig: Any, home: Path) -> dict[str, str]:
    """The rig's pod environment, with the fake CLI found on ``PATH`` by name."""
    environ = {**rig.environ, "HOME": str(home)}
    environ["PATH"] = f"{rig.binary.parent}{os.pathsep}{environ['PATH']}"
    return environ


async def test_a_staged_grok_session_runs_a_turn(tmp_path: Path):
    rig = test_grok_harness.Rig(tmp_path / "rig")
    home = tmp_path / "home"
    stager = await stage(HarnessId.GROK, home)
    with (
        patch.dict("os.environ", fake_cli_environ(rig, home), clear=True),
        patch("sandbox_runtime.cli_stager.cli_layout", return_value=stager.layout),
    ):
        harness = build(HarnessId.GROK, tmp_path, {"model": "xai/grok-4.7-build-fast"})
        outcome, events = await run_one_turn(harness, "xai/grok-4.7-build-fast")

    assert outcome.error is None, outcome.error
    assert any(event.get("type") == "token" for event in events)
    (run,) = rig.runs()
    assert run["env"]["GROK_HOME"] == str(stager.layout.cli_home)
    assert "XAI_API_KEY" not in run["env"]
    assert f"--cwd={home / 'workspace'}" in run["argv"]
    assert test_grok_harness.FAKE_TOKEN not in json.dumps(run)
    assert IDENTITY_TOKEN not in json.dumps(run["argv"])


async def test_a_staged_agy_session_runs_a_turn(tmp_path: Path):
    rig = test_agy_harness.Rig(tmp_path / "rig")
    home = tmp_path / "home"
    stager = await stage(HarnessId.AGY, home)
    with (
        patch.dict("os.environ", fake_cli_environ(rig, home), clear=True),
        patch("sandbox_runtime.cli_stager.cli_layout", return_value=stager.layout),
    ):
        harness = build(HarnessId.AGY, tmp_path, {"model": "antigravity/gemini-4-argon"})
        outcome, events = await run_one_turn(harness, "antigravity/gemini-4-argon")

    assert outcome.error is None, outcome.error
    assert any(event.get("type") == "token" for event in events)
    (run,) = rig.starts()
    assert run["home"] == str(home)
    assert run["cwd"] == str(home / "workspace")
    assert run["mcp"]["mcpServers"]["oi"]["args"][-1] == str(
        stager.layout.config_dir / TOOL_CONFIG_FILE_NAME
    )
    assert run["token"]["mode"] == 0o600
    assert "GEMINI_API_KEY" not in run["env"]
