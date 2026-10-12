"""Merging Codex's explicit-only policy into an authored agents/openai.yaml."""

from __future__ import annotations

import pytest

from sandbox_runtime.codex_skill_policy import CODEX_EXPLICIT_ONLY_POLICY, explicit_only_policy


def test_writes_the_bare_policy_without_an_authored_file() -> None:
    assert explicit_only_policy(None).content == CODEX_EXPLICIT_ONLY_POLICY
    assert explicit_only_policy(None).change == "written"


def test_keeps_an_authored_file_that_is_already_explicit_only() -> None:
    authored = "interface:\n  display_name: PR\npolicy:\n  allow_implicit_invocation: false\n"

    assert explicit_only_policy(authored).content == authored
    assert explicit_only_policy(authored).change == "kept"


@pytest.mark.parametrize(
    ("authored", "expected"),
    [
        (
            "interface:\n  display_name: PR\n  brand_color: '#123456'\n",
            "interface:\n  display_name: PR\n  brand_color: '#123456'\n"
            "policy:\n  allow_implicit_invocation: false\n",
        ),
        (
            "# comment\ndependencies:\n  tools: []",
            "# comment\ndependencies:\n  tools: []\npolicy:\n  allow_implicit_invocation: false\n",
        ),
        (
            "policy:\n    products: [codex]\n    allow_implicit_invocation: true\n"
            "interface:\n    display_name: PR\n",
            "policy:\n    allow_implicit_invocation: false\n    products: [codex]\n"
            "interface:\n    display_name: PR\n",
        ),
        (
            "policy:\n  'allow_implicit_invocation':\n    true\n  products: [codex]\n",
            "policy:\n  allow_implicit_invocation: false\n  products: [codex]\n",
        ),
        ("policy:\n", "policy:\n  allow_implicit_invocation: false\n"),
        (
            "policy: {allow_implicit_invocation: true}\ninterface:\n  display_name: PR\n",
            "interface:\n  display_name: PR\npolicy:\n  allow_implicit_invocation: false\n",
        ),
        (
            "---\ninterface:\n  display_name: PR\n",
            "---\ninterface:\n  display_name: PR\npolicy:\n  allow_implicit_invocation: false\n",
        ),
    ],
)
def test_merges_the_policy_into_a_block_mapping(authored: str, expected: str) -> None:
    policy = explicit_only_policy(authored)

    assert policy.content == expected
    assert policy.change == "merged"


@pytest.mark.parametrize(
    "authored",
    [
        "{policy: {allow_implicit_invocation: true}}\n",
        "- a\n- b\n",
        '"policy":\n  allow_implicit_invocation: true\n',
        "policy:\n  a: 1\npolicy:\n  b: 2\n",
        "interface:\n\tdisplay_name: PR\n",
        "policy:\r\n  allow_implicit_invocation: true\r\n",
        "  indented: first\n",
        "policy:\n    a: 1\n  b: 2\n",
    ],
)
def test_replaces_files_it_cannot_edit_safely(authored: str) -> None:
    policy = explicit_only_policy(authored)

    assert policy.content == CODEX_EXPLICIT_ONLY_POLICY
    assert policy.change == "replaced"
