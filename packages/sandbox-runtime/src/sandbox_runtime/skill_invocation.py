"""Explicit invocation of user-invoked-only managed skills, for harnesses that miss it.

A skill with ``disable-model-invocation: true`` is hidden from the model and
its skill tool refuses it, so it only runs when a harness expands the user's
own invocation. The web composer inserts ``/name`` or ``$name`` anywhere in a
prompt, but the bridge sends prompts as plain text:

- OpenCode expands ``/name`` only for clients that call its command endpoint;
  ``prompt_async`` stores the text unchanged.
- Claude expands ``/name`` only at the very start of a prompt; ``$name`` and a
  ``/name`` later in the text reach the model as text.

For those mentions the bridge appends the skill's instructions to the
prompt itself, as a slash command would have. Codex expands ``$name``
natively and is left alone.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .managed_skills import user_invoked_skill_dirs

if TYPE_CHECKING:
    from pathlib import Path

# The composer's trigger grammar (packages/web/src/lib/prompt-skill-completion.ts):
# `/` or `$` at the start or after whitespace, then a skill name. The name must
# end the word, so paths (`/usr/bin`) and file names (`/pr.md`) do not match.
_MENTION_RE = re.compile(
    r"(?:^|(?<=\s))[/$]([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s,;:!?)\]}'\"]|\.(?:$|\s))"
)
# What Claude itself expands: a slash command opening the prompt.
_LEADING_SLASH_RE = re.compile(r"/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|\s)")


def mentioned_skill_names(text: str) -> list[str]:
    """Skill names the prompt invokes with ``/name`` or ``$name``, in order, once each."""
    return list(dict.fromkeys(match.group(1) for match in _MENTION_RE.finditer(text)))


def leading_slash_command(text: str) -> str | None:
    """The ``/name`` a prompt opens with, which Claude expands on its own."""
    match = _LEADING_SLASH_RE.match(text)
    return match.group(1) if match else None


def _skill_body(markdown: str) -> str:
    """``SKILL.md`` without its frontmatter block."""
    if markdown.startswith("---\n"):
        end = markdown.find("\n---\n", 4)
        if end != -1:
            return markdown[end + len("\n---\n") :]
    return markdown


def _invocation_block(name: str, skill_dir: Path) -> str | None:
    try:
        markdown = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    return (
        f'<skill name="{name}" directory="{skill_dir}">\n'
        f'The user explicitly invoked the "{name}" skill. Follow its instructions below; '
        "resolve relative paths in them against the directory above.\n\n"
        f"{_skill_body(markdown).strip()}\n"
        "</skill>"
    )


def expand_explicit_skill_invocations(
    text: str,
    skills_dir: Path | None,
    *,
    natively_expanded: str | None = None,
) -> str:
    """The prompt with each explicitly invoked user-invoked-only skill appended.

    Only installed managed skills under ``skills_dir`` that disable model
    invocation are expanded; the model can load every other skill itself.
    ``natively_expanded`` names a skill the harness already expands for this
    prompt, which is not appended a second time.
    """
    if skills_dir is None:
        return text
    mentioned = [name for name in mentioned_skill_names(text) if name != natively_expanded]
    if not mentioned:
        return text
    skills = user_invoked_skill_dirs(skills_dir)
    blocks = [
        block
        for name in mentioned
        if name in skills and (block := _invocation_block(name, skills[name])) is not None
    ]
    if not blocks:
        return text
    return "\n\n".join([text, *blocks])
