"""Supervisor half of the child-per-turn CLI harnesses (grok, agy): staging only.

Like ``CodexStager``, ``CliStager`` conforms to ``HarnessProcessOwner`` while
the vendor CLI is spawned per turn by the bridge. ``start()`` prepares what
that child will see:

- a per-sandbox config directory (``~/.openinspect/<harness>``) outside every
  repository and outside the subscription home: session memory, the tool
  server's config, prompt files and attachments live here;
- the CLI's own state directory (``cli_home``), private to the sandbox user:
  a pod-local ``GROK_HOME`` for grok, the sandbox ``HOME`` for agy (agy has no
  config-dir override; only ``~/.gemini`` is made private there);
- the CLI's config naming the ``oi`` tool server, written with the same
  helpers the harness uses on open, so both write identical content;
- the standalone bin scripts the agent calls from its shell;
- a small JSON handoff naming the workdir, config directory and CLI home for
  the bridge. It carries decisions only, never a secret.

Managed skills are installed under :attr:`CliLayout.skills_dir` before this
stager runs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import AGY_HARNESS_FILE_PATH, GROK_HARNESS_FILE_PATH
from .harness import agy_env, grok_env
from .harness.base import HarnessId
from .harness.codex_tools import TOOL_CONFIG_FILE_NAME
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .repo_config import RepoEntry


CLI_CONFIG_DIR_PARENT = ".openinspect"
GROK_HOME_DIR_NAME = "home"


@dataclass(frozen=True)
class CliLayout:
    """Where one CLI harness keeps its files in this sandbox."""

    handoff_path: Path
    config_dir: Path
    cli_home: Path
    # Where the CLI discovers user-level skills; managed skills land here.
    skills_dir: Path
    # The directory the stager makes 0700: the CLI home, or agy's ``~/.gemini``.
    private_dir: Path


def cli_layout(harness: HarnessId, home: Path | None = None) -> CliLayout:
    """The layout for ``grok`` or ``agy``, under ``home`` (the sandbox user's by default)."""
    home = home or Path.home()
    config_dir = home / CLI_CONFIG_DIR_PARENT / harness.value
    match harness:
        case HarnessId.GROK:
            # GROK_HOME stands in for ~/.grok; grok reads $GROK_HOME/skills.
            grok_home = config_dir / GROK_HOME_DIR_NAME
            return CliLayout(
                handoff_path=Path(GROK_HARNESS_FILE_PATH),
                config_dir=config_dir,
                cli_home=grok_home,
                skills_dir=grok_home / "skills",
                private_dir=grok_home,
            )
        case HarnessId.AGY:
            return CliLayout(
                handoff_path=Path(AGY_HARNESS_FILE_PATH),
                config_dir=config_dir,
                cli_home=home,
                skills_dir=home / agy_env.SKILLS_DIR,
                private_dir=home / agy_env.AGY_CONFIG_DIR.parent,
            )
    raise ValueError(f"Not a CLI harness: {harness}")


@dataclass(frozen=True)
class CliHarnessHandoff:
    """What the supervisor decided and the bridge must use. Never a secret."""

    workdir: Path
    config_dir: Path
    has_repository: bool
    cli_home: Path

    def write(self, path: Path) -> None:
        payload = {
            "workdir": str(self.workdir),
            "config_dir": str(self.config_dir),
            "has_repository": self.has_repository,
            "cli_home": str(self.cli_home),
        }
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload))
        temporary.replace(path)

    @classmethod
    def read(cls, path: Path) -> CliHarnessHandoff:
        raw = json.loads(path.read_text())
        return cls(
            workdir=Path(raw["workdir"]),
            config_dir=Path(raw["config_dir"]),
            has_repository=bool(raw.get("has_repository", False)),
            cli_home=Path(raw["cli_home"]),
        )


class CliStager:
    """``HarnessProcessOwner`` for grok and agy; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        harness: HarnessId,
        has_repository: bool,
        log: Any,
        *,
        layout: CliLayout | None = None,
    ) -> None:
        self.harness = harness
        self.has_repository = has_repository
        self.log = log
        self.layout = layout or cli_layout(harness)
        self.started = False

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        layout = self.layout
        self.log.info(
            f"{self.harness.value}.stage",
            config_dir=str(layout.config_dir),
            cli_home=str(layout.cli_home),
            workdir=str(workdir),
        )
        layout.config_dir.mkdir(parents=True, exist_ok=True)
        layout.private_dir.mkdir(parents=True, exist_ok=True)
        layout.private_dir.chmod(0o700)
        # The bridge writes the tool config itself (it holds the token); the
        # path is fixed, so the CLI config can name it already.
        tool_config_path = layout.config_dir / TOOL_CONFIG_FILE_NAME
        match self.harness:
            case HarnessId.GROK:
                grok_env.write_config(layout.cli_home, tool_config_path)
            case HarnessId.AGY:
                agy_env.write_mcp_config(layout.cli_home, tool_config_path)
        install_bin_scripts(self.log)
        CliHarnessHandoff(
            workdir=workdir,
            config_dir=layout.config_dir,
            has_repository=self.has_repository,
            cli_home=layout.cli_home,
        ).write(layout.handoff_path)
        self.started = True
        self.log.info(f"{self.harness.value}.staged", repo_count=len(repositories))

    async def stop(self) -> None:
        return None

    def exit_code(self) -> int | None:
        # There is no resident vendor process; each turn's child belongs to the bridge.
        return None
