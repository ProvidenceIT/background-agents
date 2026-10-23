"""The session tool contract shared with the control plane, generated from TypeScript.

``session_tools_contract.json`` is written by ``npm run generate:session-tools-contract
-w @open-inspect/shared`` from ``packages/shared/src/session-tools.ts``; the OpenCode
tools read its JavaScript twin. Each tool names a gate; the control plane sets the
session's enabled gates in ``AGENT_SESSION_TOOLS`` at launch, and a tool is
installed only when its gate is there. None is by default.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, TypedDict, cast

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


class SessionToolSpec(TypedDict):
    name: str
    gate: str
    description: str
    method: str
    # Below ``/sessions/:id``; ``{name}`` segments are filled from (and consume) input fields.
    path: str
    inputSchema: dict[str, Any]


class SessionToolsSandboxContract(TypedDict):
    tools: list[SessionToolSpec]
    enabledGatesEnv: str


SESSION_TOOLS_CONTRACT: Final = cast(
    "SessionToolsSandboxContract",
    json.loads(Path(__file__).with_name("session_tools_contract.json").read_text(encoding="utf-8")),
)
SESSION_TOOL_SPECS: Final = SESSION_TOOLS_CONTRACT["tools"]
SESSION_TOOLS_ENV_VAR: Final = SESSION_TOOLS_CONTRACT["enabledGatesEnv"]
SESSION_TOOL_GATES: Final = frozenset(spec["gate"] for spec in SESSION_TOOL_SPECS)


def parse_enabled_gates(value: str | None) -> frozenset[str]:
    """The known gates in a comma-separated value; unknown names are ignored."""
    if not value:
        return frozenset()
    return frozenset(part.strip() for part in value.split(",")) & SESSION_TOOL_GATES


def enabled_gates_from_env(environ: Mapping[str, str] = os.environ) -> frozenset[str]:
    return parse_enabled_gates(environ.get(SESSION_TOOLS_ENV_VAR))


def enabled_session_tool_specs(gates: Iterable[str]) -> list[SessionToolSpec]:
    """The specs whose gate is enabled, in contract order."""
    enabled = frozenset(gates)
    return [spec for spec in SESSION_TOOL_SPECS if spec["gate"] in enabled]
