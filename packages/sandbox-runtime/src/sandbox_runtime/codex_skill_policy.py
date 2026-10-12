"""Codex's per-skill ``agents/openai.yaml``, made explicit-only for user-invoked skills.

Codex reads ``policy.allow_implicit_invocation`` from a skill's
``agents/openai.yaml``; when it is false the skill leaves the model's skill
list while ``$name`` still invokes it. A missing key means true, so a skill
that disables model invocation needs the key written as false, whether or
not its author shipped the file (often only for ``interface`` or
``dependencies``).

The runtime has no YAML library, so an authored file is edited line by line
when it is a plain block mapping, and replaced by the bare policy otherwise.
Replacing loses the author's display and dependency fields but never the
user-invoked-only guarantee.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

CODEX_SKILL_POLICY_PATH = "agents/openai.yaml"
CODEX_EXPLICIT_ONLY_POLICY = "policy:\n  allow_implicit_invocation: false\n"

_POLICY_KEY = "policy"
_TOP_LEVEL_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]|$)(.*)$")
_IMPLICIT_KEY_RE = re.compile(
    r"""^(?:allow_implicit_invocation|"allow_implicit_invocation"|'allow_implicit_invocation')[ \t]*:"""
)
_DEFAULT_CHILD_INDENT = "  "

PolicyChange = Literal["written", "kept", "merged", "replaced"]


@dataclass(frozen=True)
class CodexSkillPolicy:
    """The ``agents/openai.yaml`` to install and how it relates to the author's."""

    content: str
    change: PolicyChange


def _ignorable(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped.startswith("#")


def _indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" "))]


def _replaced() -> CodexSkillPolicy:
    return CodexSkillPolicy(CODEX_EXPLICIT_ONLY_POLICY, "replaced")


def explicit_only_policy(authored: str | None) -> CodexSkillPolicy:
    """The policy file that keeps a skill out of Codex's implicit invocation.

    ``authored`` is the skill's own ``agents/openai.yaml``, if it ships one.
    """
    if authored is None:
        return CodexSkillPolicy(CODEX_EXPLICIT_ONLY_POLICY, "written")
    if "\r" in authored or "\t" in authored:
        return _replaced()
    lines = authored.split("\n")
    top_level: list[tuple[int, str, str]] = []
    seen_content = False
    for index, line in enumerate(lines):
        if _ignorable(line):
            continue
        if line.startswith(" "):
            if not top_level:
                return _replaced()
            continue
        if line == "---" and not seen_content:
            seen_content = True
            continue
        match = _TOP_LEVEL_KEY_RE.match(line)
        if not match:
            # Flow collections, sequences, quoted or complex keys, documents.
            return _replaced()
        seen_content = True
        top_level.append((index, match.group(1), match.group(2)))

    policies = [entry for entry in top_level if entry[1] == _POLICY_KEY]
    if len(policies) > 1:
        return _replaced()
    if not policies:
        kept = authored.rstrip("\n")
        return CodexSkillPolicy(
            f"{kept}\n{CODEX_EXPLICIT_ONLY_POLICY}" if kept else CODEX_EXPLICIT_ONLY_POLICY,
            "merged",
        )

    start, _key, inline = policies[0]
    following = [index for index, _name, _rest in top_level if index > start]
    end = following[0] if following else len(lines)
    block = lines[start + 1 : end]
    if not _ignorable(inline):
        # An inline value (`policy: {...}`, `policy: null`, an alias): drop it
        # with its continuation lines and append a block of our own.
        merged = [*lines[:start], *lines[end:]]
        kept = "\n".join(merged).rstrip("\n")
        return CodexSkillPolicy(
            f"{kept}\n{CODEX_EXPLICIT_ONLY_POLICY}" if kept else CODEX_EXPLICIT_ONLY_POLICY,
            "merged",
        )

    children = [line for line in block if not _ignorable(line)]
    child_indent = _indent(children[0]) if children else _DEFAULT_CHILD_INDENT
    if children and (
        not child_indent or any(len(_indent(line)) < len(child_indent) for line in children)
    ):
        return _replaced()

    kept_block: list[str] = []
    skipping = False
    for line in block:
        if skipping:
            if _ignorable(line) or len(_indent(line)) > len(child_indent):
                continue
            skipping = False
        if _indent(line) == child_indent and _IMPLICIT_KEY_RE.match(line[len(child_indent) :]):
            skipping = True
            continue
        kept_block.append(line)
    explicit_only = f"{child_indent}allow_implicit_invocation: false"
    merged = [*lines[: start + 1], explicit_only, *kept_block, *lines[end:]]
    content = "\n".join(merged)
    if not content.endswith("\n"):
        content += "\n"
    if content == authored:
        return CodexSkillPolicy(authored, "kept")
    return CodexSkillPolicy(content, "merged")
