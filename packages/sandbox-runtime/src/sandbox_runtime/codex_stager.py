"""Supervisor half of the Codex harness: staging only, no resident process.

Like ``ClaudeStager``, ``CodexStager`` conforms to ``HarnessProcessOwner``
while the vendor process (``codex exec``) is spawned per turn by the bridge.
``start()`` prepares what that child will see:

- a per-sandbox config directory outside every repository and outside the
  subscription home (``CODEX_HOME`` is the home, shared by every session it
  serves, so nothing session-specific is written there): managed skills,
  session memory and the tool server's config live here;
- the standalone bin scripts the agent calls from its shell;
- a small JSON handoff (``CODEX_HARNESS_FILE_PATH``) naming the workdir and
  config directory for the bridge. It carries decisions only, never a secret.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import CODEX_HARNESS_FILE_PATH
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .repo_config import RepoEntry


DEFAULT_CODEX_CONFIG_DIR_NAME = ".openinspect/codex"


def resolve_codex_config_dir() -> Path:
    """Per-sandbox harness directory; never the subscription home's ``CODEX_HOME``."""
    return Path.home() / DEFAULT_CODEX_CONFIG_DIR_NAME


@dataclass(frozen=True)
class CodexHarnessHandoff:
    """What the supervisor decided and the bridge must use. Never a secret."""

    workdir: Path
    config_dir: Path
    has_repository: bool

    def write(self, path: Path = Path(CODEX_HARNESS_FILE_PATH)) -> None:
        payload = {
            "workdir": str(self.workdir),
            "config_dir": str(self.config_dir),
            "has_repository": self.has_repository,
        }
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload))
        temporary.replace(path)

    @classmethod
    def read(cls, path: Path = Path(CODEX_HARNESS_FILE_PATH)) -> CodexHarnessHandoff:
        raw = json.loads(path.read_text())
        return cls(
            workdir=Path(raw["workdir"]),
            config_dir=Path(raw["config_dir"]),
            has_repository=bool(raw.get("has_repository", False)),
        )


class CodexStager:
    """``HarnessProcessOwner`` for the Codex harness; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        has_repository: bool,
        log: Any,
        *,
        config_dir: Path | None = None,
        handoff_path: Path = Path(CODEX_HARNESS_FILE_PATH),
    ) -> None:
        self.has_repository = has_repository
        self.log = log
        self.config_dir = config_dir or resolve_codex_config_dir()
        self.handoff_path = handoff_path
        self.started = False

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        self.log.info("codex.stage", config_dir=str(self.config_dir), workdir=str(workdir))
        self.config_dir.mkdir(parents=True, exist_ok=True)
        install_bin_scripts(self.log)
        CodexHarnessHandoff(
            workdir=workdir,
            config_dir=self.config_dir,
            has_repository=self.has_repository,
        ).write(self.handoff_path)
        self.started = True
        self.log.info("codex.staged", repo_count=len(repositories))

    async def stop(self) -> None:
        return None

    def exit_code(self) -> int | None:
        # There is no resident vendor process; each turn's child belongs to the bridge.
        return None
