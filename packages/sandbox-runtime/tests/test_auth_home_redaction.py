"""Credentials of a mounted subscription home never leave the bridge in an event."""

import json
import os
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


def _codex_pool_home(tmp_path: Path) -> Path:
    """A Codex claim as a pool pod mounts it: codex/ plus codex-pool/<slot>/auth.json."""
    home = tmp_path / "sf-auth-codex"
    (home / "codex").mkdir(parents=True)
    for slot in ("codex-1", "codex-2"):
        (home / "codex-pool" / slot).mkdir(parents=True)
        (home / "codex-pool" / slot / "auth.json").write_text(
            json.dumps({"tokens": {"refresh_token": f"{slot}-placeholder-refresh-token"}})
        )
    (home / "codex" / "auth.json").symlink_to("../codex-pool/codex-1/auth.json")
    return home


def test_redacts_every_codex_pool_login_and_follows_a_re_enrolment(tmp_path: Path):
    home = _codex_pool_home(tmp_path)
    redactor = AuthHomeSecretRedactor(home)

    redacted = redactor.redact(
        _tool_result("codex-1-placeholder-refresh-token codex-2-placeholder-refresh-token")
    )
    assert redacted["output"] == "*** ***"

    (home / "codex-pool" / "codex-2" / "auth.json").write_text(
        json.dumps({"tokens": {"refresh_token": "codex-2-re-enrolled-refresh-token"}})
    )
    (home / "codex-pool" / "codex-3").mkdir()
    (home / "codex-pool" / "codex-3" / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": "codex-3-late-access-token"}})
    )
    redacted = redactor.redact(
        _tool_result("codex-2-re-enrolled-refresh-token codex-3-late-access-token")
    )
    assert redacted["output"] == "*** ***"


GROK_ACCESS = "xai-placeholder-pushed-access-token"
AGY_ACCESS = "ya29.placeholder-pushed-access-token"


def _pushed_home(tmp_path: Path) -> Path:
    """A home with SuperGrok and Antigravity tokens pushed into grok/ and agy/."""
    home = tmp_path / "sf-auth-pushed"
    for cli, token in (("grok", GROK_ACCESS), ("agy", AGY_ACCESS)):
        (home / cli).mkdir(parents=True)
        (home / cli / "access.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "provider": cli,
                    "access_token": token,
                    "expires_at": 1_800_000_000,
                    "pushed_at": 1_799_999_000,
                    "source": "pc-test-desktop",
                    "account_tag": "0a1b2c3d",
                }
            )
        )
    return home


def test_redacts_both_pushed_access_tokens_and_follows_a_new_push(tmp_path: Path):
    home = _pushed_home(tmp_path)
    redactor = AuthHomeSecretRedactor(home)

    redacted = redactor.redact(_tool_result(f"grok {GROK_ACCESS} agy {AGY_ACCESS}"))
    assert redacted["output"] == "grok *** agy ***"

    (home / "agy" / "access.json").write_text(
        json.dumps({"schema": 1, "access_token": "ya29.placeholder-next-push", "expires_at": 1})
    )
    redacted = redactor.redact(_tool_result("ya29.placeholder-next-push"))
    assert redacted["output"] == "***"


def test_a_pushed_token_stays_redacted_after_the_next_push(tmp_path: Path):
    # The replaced token still works until it expires, and agy's own copy lags the push.
    home = _pushed_home(tmp_path)
    redactor = AuthHomeSecretRedactor(home)
    assert redactor.redact(_tool_result(AGY_ACCESS))["output"] == "***"

    (home / "agy" / "access.json").write_text(
        json.dumps({"schema": 1, "access_token": "ya29.placeholder-next-push", "expires_at": 1})
    )
    redacted = redactor.redact(_tool_result(f"{AGY_ACCESS} ya29.placeholder-next-push"))
    assert redacted["output"] == "*** ***"


def test_only_the_last_pushed_tokens_are_kept(tmp_path: Path):
    home = _pushed_home(tmp_path)
    redactor = AuthHomeSecretRedactor(home)
    redactor.redact(_tool_result(""))
    access = home / "grok" / "access.json"
    for index in range(20):
        access.write_text(
            json.dumps({"schema": 1, "access_token": f"xai-placeholder-push-{index:02d}"})
        )
        # Same size each time; a distinct mtime marks each push as new.
        os.utime(access, ns=(index * 10**9, index * 10**9))
        redactor.redact(_tool_result(""))
    redacted = redactor.redact(_tool_result("xai-placeholder-push-00 xai-placeholder-push-19"))
    assert redacted["output"] == "xai-placeholder-push-00 ***"


def test_the_pushed_files_ordinary_fields_are_not_redacted(tmp_path: Path):
    redactor = AuthHomeSecretRedactor(_pushed_home(tmp_path))
    text = "antigravity pushed from pc-test-desktop as 0a1b2c3d"
    assert redactor.redact(_tool_result(text))["output"] == text
