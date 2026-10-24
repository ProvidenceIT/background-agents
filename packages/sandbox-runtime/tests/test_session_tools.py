"""The generated session tools: gated per session, the same requests on every harness."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx

from sandbox_runtime.harness.claude_tools import (
    ControlPlaneToolClient,
    ToolServerConfig,
    build_tools,
)
from sandbox_runtime.harness.codex_tools import read_tool_config, write_tool_config
from sandbox_runtime.session_tools_contract import (
    SESSION_TOOL_GATES,
    SESSION_TOOL_SPECS,
    SESSION_TOOLS_ENV_VAR,
    enabled_gates_from_env,
    enabled_session_tool_specs,
    parse_enabled_gates,
)


def _config(tmp_path: Path, session_tools: frozenset[str] = frozenset()) -> ToolServerConfig:
    return ToolServerConfig(
        control_plane_url="https://control.test",
        session_id="session",
        auth_token="token",
        repo_manifest_path=tmp_path / "repos.json",
        has_repository=False,
        slack_notify_enabled=False,
        session_tools=session_tools,
    )


def _client(tmp_path: Path, handler, session_tools=frozenset()) -> ControlPlaneToolClient:
    return ControlPlaneToolClient(
        _config(tmp_path, session_tools),
        MagicMock(),
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_the_contract_names_a_known_gate_for_every_tool() -> None:
    assert [spec["name"] for spec in SESSION_TOOL_SPECS] == [
        "notify_user",
        "motion_get_task",
        "motion_add_note",
        "repo_context",
    ]
    assert {"notify", "motion_read", "motion_write", "repo_context"} == SESSION_TOOL_GATES
    assert SESSION_TOOLS_ENV_VAR == "AGENT_SESSION_TOOLS"


def test_only_known_gates_are_enabled() -> None:
    assert parse_enabled_gates(None) == frozenset()
    assert parse_enabled_gates("") == frozenset()
    assert parse_enabled_gates(" notify , ask_openclaw,motion_read") == {"notify", "motion_read"}
    assert enabled_gates_from_env({}) == frozenset()
    assert enabled_gates_from_env({SESSION_TOOLS_ENV_VAR: "motion_write"}) == {"motion_write"}
    assert [spec["name"] for spec in enabled_session_tool_specs({"motion_write"})] == [
        "motion_add_note"
    ]


async def test_claude_gets_no_session_tool_by_default(tmp_path: Path) -> None:
    client = _client(tmp_path, lambda _: httpx.Response(200))
    try:
        names = {tool.name for tool in build_tools(client)}
    finally:
        await client.aclose()
    assert names.isdisjoint(spec["name"] for spec in SESSION_TOOL_SPECS)


async def test_claude_gets_exactly_the_enabled_tools_from_the_generated_specs(
    tmp_path: Path,
) -> None:
    client = _client(tmp_path, lambda _: httpx.Response(200), frozenset({"notify"}))
    try:
        tools = {tool.name: tool for tool in build_tools(client)}
    finally:
        await client.aclose()
    spec = SESSION_TOOL_SPECS[0]
    assert "notify_user" in tools
    assert "motion_get_task" not in tools and "motion_add_note" not in tools
    assert tools["notify_user"].description == spec["description"]
    assert tools["notify_user"].input_schema == spec["inputSchema"]


async def test_claude_notify_sends_declared_fields_only(tmp_path: Path) -> None:
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(202, json={"status": "queued"})

    client = _client(tmp_path, handler, frozenset({"notify"}))
    try:
        notify = next(tool for tool in build_tools(client) if tool.name == "notify_user")
        result = await notify.handler(
            {"message": "PR ready", "urgency": "high", "recipient": "someone@example.com"}
        )
    finally:
        await client.aclose()
    assert sent[0].url.raw_path == b"/sessions/session/notify"
    assert sent[0].headers["Authorization"] == "Bearer token"
    assert json.loads(sent[0].content) == {"message": "PR ready", "urgency": "high"}
    assert json.loads(result["content"][0]["text"]) == {"status": "queued"}


async def test_claude_reports_a_refused_motion_call_as_an_error(tmp_path: Path) -> None:
    client = _client(
        tmp_path,
        lambda _: httpx.Response(403, json={"error": "Not a motion session"}),
        frozenset({"motion_read"}),
    )
    try:
        get_task = next(tool for tool in build_tools(client) if tool.name == "motion_get_task")
        result = await get_task.handler({})
    finally:
        await client.aclose()
    assert result["is_error"] is True
    assert result["content"][0]["text"] == "motion_get_task failed (403): Not a motion session"


def test_codex_tool_config_keeps_the_enabled_gates(tmp_path: Path) -> None:
    config = _config(tmp_path, frozenset({"notify", "motion_read"}))
    path = write_tool_config(config, tmp_path)
    assert json.loads(path.read_text())["session_tools"] == ["motion_read", "notify"]
    assert read_tool_config(path) == config

    raw = json.loads(path.read_text())
    del raw["session_tools"]
    path.write_text(json.dumps(raw))
    assert read_tool_config(path).session_tools == frozenset()
