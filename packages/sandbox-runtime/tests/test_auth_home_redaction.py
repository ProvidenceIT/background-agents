"""Credentials of a mounted subscription home never leave the bridge in an event."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.auth_home import AuthHomeSecretRedactor
from sandbox_runtime.event_forwarder import BufferedEventForwarder
from tests.event_forwarder_fakes import open_ws, sent_events

CLAUDE_TOKEN = "sk-ant-oat01-placeholder-subscriber-token"
GLM_KEY = "glm-placeholder-plan-key"
CODEX_REFRESH = "codex-placeholder-refresh-token"
CODEX_ACCESS = "codex-placeholder-access-token"


def _home(tmp_path: Path) -> Path:
    home = tmp_path / "sf-auth"
    (home / "claude").mkdir(parents=True)
    (home / "claude" / "oauth-token").write_text(CLAUDE_TOKEN + "\n")
    (home / "env").write_text(f'# plan keys\nexport ZHIPU_API_KEY="{GLM_KEY}"\nSHORT=abc\n')
    (home / "codex").mkdir()
    (home / "codex" / "auth.json").write_text(
        json.dumps(
            {
                "OPENAI_API_KEY": None,
                "tokens": {"access_token": CODEX_ACCESS, "refresh_token": CODEX_REFRESH},
            }
        )
    )
    return home


def _tool_result(output: str) -> dict:
    return {"type": "tool_result", "messageId": "m1", "output": output, "nested": [{"o": output}]}


def test_redacts_every_credential_the_home_holds(tmp_path: Path):
    redactor = AuthHomeSecretRedactor(_home(tmp_path))
    output = (
        f"CLAUDE_CODE_OAUTH_TOKEN={CLAUDE_TOKEN}\nZHIPU_API_KEY={GLM_KEY}\n"
        f'{{"refresh_token": "{CODEX_REFRESH}", "access_token": "{CODEX_ACCESS}"}}\nSHORT=abc'
    )

    redacted = redactor.redact(_tool_result(output))

    text = json.dumps(redacted)
    for secret in (CLAUDE_TOKEN, GLM_KEY, CODEX_REFRESH, CODEX_ACCESS):
        assert secret not in text
    assert redacted["output"].count("***") == 4
    # Values too short to be credentials are left alone.
    assert "SHORT=abc" in redacted["output"]
    assert redacted["nested"][0]["o"] == redacted["output"]


def test_follows_a_rewritten_token_and_any_claude_token_shape(tmp_path: Path):
    home = _home(tmp_path)
    redactor = AuthHomeSecretRedactor(home)
    redactor.redact(_tool_result("warm the cache"))
    (home / "claude" / "oauth-token").write_text("sk-ant-oat01-a-reminted-token-value-x")

    redacted = redactor.redact(
        _tool_result("new sk-ant-oat01-a-reminted-token-value-x old sk-ant-oat01-stale_copy")
    )

    assert redacted["output"] == "new *** old ***"


def test_without_a_home_there_is_no_redactor(tmp_path: Path):
    assert AuthHomeSecretRedactor.from_environ({}) is None
    redactor = AuthHomeSecretRedactor.from_environ({"SF_AUTH_HOME": str(tmp_path / "missing")})
    assert redactor is not None
    assert redactor.redact({"type": "token", "content": "plain"}) == {
        "type": "token",
        "content": "plain",
    }


@pytest.mark.asyncio
async def test_the_forwarder_sends_and_buffers_only_redacted_events(tmp_path: Path):
    redactor = AuthHomeSecretRedactor(_home(tmp_path))
    forwarder = BufferedEventForwarder(
        sandbox_id="test-sandbox", log=MagicMock(), redact=redactor.redact
    )

    # Buffered while unbound, then flushed on bind.
    await forwarder.send(_tool_result(f"env says {CLAUDE_TOKEN}"))
    ws = open_ws()
    await forwarder.bind(ws)
    await forwarder.send({"type": "execution_complete", "messageId": "m1", "error": GLM_KEY})

    sent = sent_events(ws)
    assert [event["type"] for event in sent] == ["tool_result", "execution_complete"]
    assert CLAUDE_TOKEN not in json.dumps(sent)
    assert GLM_KEY not in json.dumps(sent)
    assert sent[0]["output"] == "env says ***"
    # A critical event keeps its ack id through redaction.
    assert sent[1]["ackId"]
