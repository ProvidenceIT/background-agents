"""CliStager: the supervisor half of the grok and agy harnesses."""

from __future__ import annotations

import dataclasses
import json
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import pytest

from sandbox_runtime.cli_stager import CliHarnessHandoff, CliStager, cli_layout
from sandbox_runtime.harness.base import HarnessId
from sandbox_runtime.harness.grok_env import config_toml

if TYPE_CHECKING:
    from pathlib import Path


def stager_for(harness: HarnessId, home: Path) -> CliStager:
    layout = dataclasses.replace(cli_layout(harness, home), handoff_path=home / "handoff.json")
    return CliStager(harness, True, MagicMock(), layout=layout)


async def start(stager: CliStager, workdir: Path) -> None:
    with patch("sandbox_runtime.cli_stager.install_bin_scripts"):
        await stager.start((), workdir)


def test_only_grok_and_agy_have_a_cli_layout(tmp_path: Path):
    with pytest.raises(ValueError, match="Not a CLI harness"):
        cli_layout(HarnessId.CODEX, tmp_path)


def test_the_handoff_round_trips_and_carries_no_secret(tmp_path: Path):
    path = tmp_path / "handoff.json"
    handoff = CliHarnessHandoff(tmp_path / "w", tmp_path / "c", True, tmp_path / "h")
    handoff.write(path)

    assert CliHarnessHandoff.read(path) == handoff
    assert not path.with_suffix(".tmp").exists()
    assert set(json.loads(path.read_text())) == {
        "workdir",
        "config_dir",
        "has_repository",
        "cli_home",
    }


async def test_grok_config_is_the_one_the_harness_writes_on_open(tmp_path: Path):
    stager = stager_for(HarnessId.GROK, tmp_path)
    await start(stager, tmp_path / "workspace")

    tool_config = stager.layout.config_dir / "oi-tools.json"
    assert (stager.layout.cli_home / "config.toml").read_text() == config_toml(tool_config)


async def test_a_grok_home_the_skills_install_created_is_made_private(tmp_path: Path):
    # Managed skills land in $GROK_HOME/skills before the stager runs.
    stager = stager_for(HarnessId.GROK, tmp_path)
    stager.layout.skills_dir.mkdir(parents=True)
    stager.layout.cli_home.chmod(0o755)
    await start(stager, tmp_path / "workspace")

    assert stager.layout.cli_home.stat().st_mode & 0o777 == 0o700
    assert stager.layout.skills_dir.is_dir()


async def test_agy_leaves_the_home_mode_alone(tmp_path: Path):
    tmp_path.chmod(0o755)
    stager = stager_for(HarnessId.AGY, tmp_path)
    await start(stager, tmp_path / "workspace")

    assert tmp_path.stat().st_mode & 0o777 == 0o755
    assert stager.layout.private_dir == tmp_path / ".gemini"
    assert stager.layout.private_dir.stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("harness", [HarnessId.GROK, HarnessId.AGY])
async def test_a_restarted_supervisor_stages_again(tmp_path: Path, harness: HarnessId):
    stager = stager_for(harness, tmp_path)
    await start(stager, tmp_path / "workspace")
    await start(stager, tmp_path / "workspace")

    assert stager.started
    assert CliHarnessHandoff.read(stager.layout.handoff_path).workdir == tmp_path / "workspace"
    await stager.stop()
    assert stager.exit_code() is None
