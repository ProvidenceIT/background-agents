"""OpenCode refuses Anthropic models and a missing model, and writes no default of its own."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.harness import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.base import ANTHROPIC_MODEL_REFUSAL, NO_MODEL_SELECTED
from sandbox_runtime.harness.opencode import OpencodeHarness, model_refusal
from tests.runtime_helpers import make_opencode_server

if TYPE_CHECKING:
    from pathlib import Path


def _harness() -> OpencodeHarness:
    harness = OpencodeHarness(
        client=MagicMock(),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=PromptLimits(
            inactivity_timeout_seconds=300.0,
            prompt_max_duration_seconds=600.0,
            prompt_cleanup_timeout_seconds=30.0,
        ),
    )
    harness.session_id = "ses_1"
    return harness


@pytest.mark.parametrize(
    ("model", "error"),
    [
        ("anthropic/claude-opus-5-5", ANTHROPIC_MODEL_REFUSAL),
        # OpenCode sends a bare id as an Anthropic model.
        ("claude-sonnet-4-6", ANTHROPIC_MODEL_REFUSAL),
        ("", NO_MODEL_SELECTED),
        (None, NO_MODEL_SELECTED),
    ],
)
async def test_a_refused_model_fails_the_turn_without_opening_a_stream(
    model: str | None, error: str
) -> None:
    harness = _harness()
    emit = AsyncMock()

    with patch.object(OpencodeHarness, "stream_events") as stream:
        outcome = await harness.run_prompt(
            HarnessPrompt(message_id="m1", text="hi", model=model), emit
        )

    assert not outcome.success
    assert outcome.error == error
    stream.assert_not_called()
    emit.assert_not_called()
    harness.client.assert_not_called()


@pytest.mark.parametrize("model", ["openai/gpt-6.1-sol", "xai/grok-4.7", "zai/glm-5"])
def test_other_providers_may_run(model: str) -> None:
    assert model_refusal(model) is None


async def test_an_allowed_model_streams_as_before() -> None:
    harness = _harness()
    emit = AsyncMock()

    async def events(_prompt: HarnessPrompt):
        yield {"type": "token", "content": "hi"}

    with patch.object(OpencodeHarness, "stream_events", side_effect=events):
        outcome = await harness.run_prompt(
            HarnessPrompt(message_id="m1", text="hi", model="openai/gpt-6.1-sol"), emit
        )

    assert outcome.success
    emit.assert_awaited_once_with({"type": "token", "content": "hi"})


async def _started_config(server, tmp_path: Path) -> dict:
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    return json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])


async def test_a_session_without_a_model_writes_no_default_model(tmp_path: Path) -> None:
    server = make_opencode_server({}, workspace_path=tmp_path)
    assert (server.provider, server.model) == ("", "")

    config = await _started_config(server, tmp_path)

    assert "model" not in config


async def test_a_session_model_is_still_the_default(tmp_path: Path) -> None:
    session = json.dumps({"provider": "openai", "model": "gpt-6.1-sol"})
    server = make_opencode_server({"SESSION_CONFIG": session}, workspace_path=tmp_path)

    config = await _started_config(server, tmp_path)

    assert config["model"] == "openai/gpt-6.1-sol"
