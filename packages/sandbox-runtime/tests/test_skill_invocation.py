"""Explicit invocation of user-invoked-only managed skills through the bridge."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness import HarnessPrompt
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.skill_invocation import (
    expand_explicit_skill_invocations,
    leading_slash_command,
    mentioned_skill_names,
)
from tests.claude_fakes import Harness

if TYPE_CHECKING:
    from pathlib import Path

_USER_INVOKED = (
    "---\n"
    "name: pr\n"
    'description: "Opens a pull request"\n'
    "disable-model-invocation: true\n"
    "---\n"
    "# Open a pull request\n\nRun scripts/open.sh.\n"
)
_MODEL_INVOKED = "---\nname: review\ndescription: d\n---\n# Review\n"


def _install(skills_dir: Path) -> None:
    for name, markdown in {"pr": _USER_INVOKED, "review": _MODEL_INVOKED}.items():
        (skills_dir / name).mkdir(parents=True)
        (skills_dir / name / "SKILL.md").write_text(markdown)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("/pr", ["pr"]),
        ("$pr please", ["pr"]),
        ("fix the lint then /pr.", ["pr"]),
        ("first $pr, then /review and $pr again", ["pr", "review"]),
        ("(see /pr)", ["pr"]),
        ("(/pr)", []),
        ("open /pr.md and /usr/bin", []),
        ("a/pr or x$pr", []),
    ],
)
def test_mentions_follow_the_composer_trigger_grammar(text: str, expected: list[str]) -> None:
    assert mentioned_skill_names(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [("/pr", "pr"), ("/pr fix it", "pr"), (" /pr", None), ("$pr", None), ("/pr.", None)],
)
def test_leading_slash_command_is_what_claude_expands(text: str, expected: str | None) -> None:
    assert leading_slash_command(text) == expected


def test_appends_only_user_invoked_skills_that_the_prompt_names(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    _install(skills)

    expanded = expand_explicit_skill_invocations("run $review and then /pr now", skills)

    assert expanded.startswith('run $review and then /pr now\n\n<skill name="pr" ')
    assert f'directory="{skills / "pr"}"' in expanded
    assert "# Open a pull request\n\nRun scripts/open.sh.\n</skill>" in expanded
    assert "disable-model-invocation" not in expanded
    assert "# Review" not in expanded


def test_leaves_prompts_alone_without_a_user_invoked_mention(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    _install(skills)

    assert expand_explicit_skill_invocations("/review this", skills) == "/review this"
    assert expand_explicit_skill_invocations("/unknown", skills) == "/unknown"
    assert expand_explicit_skill_invocations("/pr", None) == "/pr"
    assert expand_explicit_skill_invocations("/pr", tmp_path / "missing") == "/pr"
    assert (
        expand_explicit_skill_invocations("/pr and $pr", skills, natively_expanded="pr")
        == "/pr and $pr"
    )


async def test_opencode_sends_the_skill_with_a_slash_invocation(tmp_path: Path) -> None:
    """OpenCode's prompt_async never expands `/pr`; the deny rule hides the skill."""
    skills = tmp_path / "skills"
    _install(skills)
    harness = OpencodeHarness(
        client=MagicMock(),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=MagicMock(),
        managed_skills_dir=skills,
    )
    harness.session_id = "oc-session"
    stream = MagicMock()
    harness._prompt_stream = stream

    harness.stream_events(HarnessPrompt(message_id="m1", text="/pr"))

    content = stream.stream_prompt.call_args.kwargs["content"]
    assert content.startswith('/pr\n\n<skill name="pr" ')
    assert "Run scripts/open.sh." in content


async def _claude_text(tmp_path: Path, text: str) -> Any:
    h = Harness(tmp_path)
    _install(h.config.config_dir / "skills")
    messages = [
        message
        async for message in h.harness._user_messages(HarnessPrompt(message_id="m1", text=text))
    ]
    return messages[0]["message"]["content"][0]["text"]


async def test_claude_expands_dollar_and_later_slash_invocations(tmp_path: Path) -> None:
    text = await _claude_text(tmp_path, "fix the lint then /pr")

    assert text.startswith('fix the lint then /pr\n\n<skill name="pr" ')
    assert "Run scripts/open.sh." in text


async def test_claude_leaves_a_leading_slash_command_to_its_own_expansion(
    tmp_path: Path,
) -> None:
    assert await _claude_text(tmp_path, "/pr then $pr") == "/pr then $pr"
