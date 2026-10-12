"""Fetch, validate, and install control-plane-managed skills for every harness."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

from .codex_skill_policy import CODEX_SKILL_POLICY_PATH, explicit_only_policy
from .control_plane_fetch import ResponseTooLargeError, fetch_bounded
from .durable_files import atomic_write_private, fsync_directory

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from collections.abc import Set as AbstractSet

    from .repo_config import RepoEntry

MAX_SKILL_NAME_LENGTH = 64
MAX_SKILL_FILES = 100
MAX_SKILL_FILE_BYTES = 256 * 1024
MAX_SKILL_REVISION_BYTES = 1024 * 1024
MAX_SKILL_PATH_BYTES = 240
MAX_SKILL_PATH_DEPTH = 10
MAX_MANAGED_SKILL_MANIFEST_BYTES = 5 * 1024 * 1024
MAX_MANAGED_SKILL_RESPONSE_BYTES = 32 * 1024 * 1024
MANAGED_SKILLS_FETCH_TIMEOUT_SECONDS = 15.0
# Skills per request. Per-file JSON framing does not count against the manifest's
# content aggregate, so a wide manifest can exceed a single response's ceiling
# even while passing resolution. Requesting a fixed window keeps every response
# far below MAX_MANAGED_SKILL_RESPONSE_BYTES regardless of how wide it is.
MANAGED_SKILLS_PAGE_SIZE = 50

_SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_YAML_NAME_RE = re.compile(
    r"""^\s*(?:name|"name"|'name')\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))"""
)
_DISCOVERY_PATHS = (".opencode/skills", ".claude/skills", ".agents/skills")
# The control plane renders preserved frontmatter one plain key per line with a
# JSON value, so the flag is exactly this line when set.
_DISABLE_MODEL_INVOCATION_RE = re.compile(r"^disable-model-invocation:[ \t]*true[ \t]*$")
# Skill-reading bound shared by every frontmatter scan of an installed tree.
_SKILL_MARKDOWN_SCAN_BYTES = 65536
_STAGING_PREFIX = ".managed-skills-"


class ManagedSkillsError(RuntimeError):
    """A managed-skill startup failure with a stable error code."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ManagedSkillFile:
    path: str
    content: str
    sha256: str
    size_bytes: int
    executable: bool


@dataclass(frozen=True)
class ManagedSkill:
    name: str
    files: tuple[ManagedSkillFile, ...]


@dataclass(frozen=True)
class ManagedSkillInstallation:
    manifest_sha256: str
    skills: tuple[ManagedSkill, ...]


@dataclass(frozen=True)
class ManagedSkillInstallationPage:
    """One response's worth of an installation, plus where to resume."""

    manifest_sha256: str
    skills: tuple[ManagedSkill, ...]
    next_cursor: str | None


class ManagedSkillsClient:
    """Provider-neutral async client for the sandbox-only skills endpoints."""

    def __init__(
        self,
        control_plane_url: str,
        session_id: str,
        sandbox_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = control_plane_url.rstrip("/")
        self._session_id = session_id
        self._headers = {"Authorization": f"Bearer {sandbox_token}"}
        self._transport = transport

    @property
    def _skills_url(self) -> str:
        session_id = quote(self._session_id, safe="")
        return f"{self._base_url}/sessions/{session_id}/sandbox-skills"

    async def fetch_installation(
        self, *, cursor: str | None = None, limit: int | None = None
    ) -> bytes:
        """Fetch one page of the session-bound installation DTO.

        Omitting `limit` requests the whole installation in one response, which
        is the shape a control plane predating paging returns either way.
        """
        url = self._skills_url
        if limit is not None:
            query = f"limit={limit}"
            if cursor is not None:
                query += f"&cursor={quote(cursor, safe='')}"
            url = f"{url}?{query}"
        try:
            return await fetch_bounded(
                url,
                headers=self._headers,
                max_bytes=MAX_MANAGED_SKILL_RESPONSE_BYTES,
                timeout_seconds=MANAGED_SKILLS_FETCH_TIMEOUT_SECONDS,
                transport=self._transport,
            )
        except ResponseTooLargeError as error:
            raise ManagedSkillsError(
                "managed skills installation exceeds the size limit",
                code="installation_too_large",
            ) from error
        except (httpx.HTTPError, OSError) as error:
            raise ManagedSkillsError(
                f"failed to fetch managed skills: {error}", code="fetch_failed"
            ) from error


def _require_object(value: Any, keys: set[str], context: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or not keys.issubset(value):
        raise ManagedSkillsError(f"invalid {context} object", code="installation_invalid")
    return value


def _require_string(value: Any, context: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not value and not allow_empty):
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManagedSkillsError(
            f"invalid UTF-8 in {context}", code="installation_invalid"
        ) from error
    return value


def _require_int(value: Any, context: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    return value


def _validate_sha256(value: Any, context: str) -> str:
    digest = _require_string(value, context)
    if not _SHA256_RE.fullmatch(digest):
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    return digest


def _validate_path(value: Any) -> str:
    path = _require_string(value, "skill file path")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManagedSkillsError("invalid skill file path", code="path_invalid") from error
    parts = path.split("/")
    if (
        path.startswith("/")
        or "\\" in path
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
        or len(encoded) > MAX_SKILL_PATH_BYTES
        or len(parts) > MAX_SKILL_PATH_DEPTH
        or any(part in {"", ".", ".."} for part in parts)
        or PurePosixPath(path).is_absolute()
    ):
        raise ManagedSkillsError(f"unsafe skill file path: {path!r}", code="path_invalid")
    return path


def validate_installation(raw: bytes) -> ManagedSkillInstallation:
    """Validate a complete installation delivered as a single response."""
    page, _ = validate_installation_page(
        raw, names=set(), content_bytes=0, expected_manifest_sha256=None
    )
    if page.next_cursor is not None:
        raise ManagedSkillsError(
            "managed skills installation is paged but was read whole",
            code="installation_invalid",
        )
    return ManagedSkillInstallation(page.manifest_sha256, page.skills)


def validate_installation_page(
    raw: bytes,
    *,
    names: set[str],
    content_bytes: int,
    expected_manifest_sha256: str | None,
) -> tuple[ManagedSkillInstallationPage, int]:
    """Validate untrusted installation bytes independently of the control plane.

    The narrow DTO omits selection and assignment provenance, so manifest_sha256
    is an opaque identifier here. File hashes, paths, sizes, names, and modes are
    validated locally before any content reaches an OpenCode discovery path.

    Duplicate skill names and the content aggregate are properties of the whole
    installation, not of one response, so `names` is read and extended in place
    and `content_bytes` carries forward. `expected_manifest_sha256` pins every
    page after the first to the installation the first page described.
    """
    if len(raw) > MAX_MANAGED_SKILL_RESPONSE_BYTES:
        raise ManagedSkillsError(
            "managed skills installation exceeds the size limit", code="installation_too_large"
        )
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManagedSkillsError(
            "managed skills installation is not valid JSON", code="installation_invalid"
        ) from error
    installation = _require_object(
        document,
        {"schemaVersion", "manifestSha256", "skills"},
        "installation",
    )
    if type(installation["schemaVersion"]) is not int or installation["schemaVersion"] != 1:
        raise ManagedSkillsError(
            "unsupported managed skills schema version", code="installation_invalid"
        )
    manifest_sha256 = _validate_sha256(installation["manifestSha256"], "manifest SHA-256")
    if expected_manifest_sha256 is not None and manifest_sha256 != expected_manifest_sha256:
        raise ManagedSkillsError(
            "managed skills pages describe different manifests", code="installation_invalid"
        )
    next_cursor = installation.get("nextCursor")
    if next_cursor is not None:
        next_cursor = _require_string(next_cursor, "managed skills cursor")
    raw_skills = installation["skills"]
    if not isinstance(raw_skills, list):
        raise ManagedSkillsError("invalid managed skills list", code="installation_invalid")

    skills: list[ManagedSkill] = []
    installation_content_bytes = content_bytes
    for raw_skill in raw_skills:
        skill = _require_object(
            raw_skill,
            {"name", "files"},
            "skill",
        )
        name = _require_string(skill["name"], "skill name")
        if len(name) > MAX_SKILL_NAME_LENGTH or not _SKILL_NAME_RE.fullmatch(name):
            raise ManagedSkillsError(f"invalid skill name: {name!r}", code="installation_invalid")
        if name in names:
            raise ManagedSkillsError(
                f"duplicate managed skill name: {name}", code="installation_invalid"
            )
        names.add(name)
        raw_files = skill["files"]
        if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_SKILL_FILES:
            raise ManagedSkillsError("invalid skill files list", code="installation_invalid")
        files: list[ManagedSkillFile] = []
        paths: set[str] = set()
        revision_bytes = 0
        for raw_file in raw_files:
            file = _require_object(
                raw_file, {"path", "content", "sha256", "sizeBytes", "executable"}, "skill file"
            )
            path = _validate_path(file["path"])
            if path in paths:
                raise ManagedSkillsError(
                    f"duplicate skill file path: {path}", code="installation_invalid"
                )
            if any(
                path.startswith(f"{existing}/") or existing.startswith(f"{path}/")
                for existing in paths
            ):
                raise ManagedSkillsError(
                    f"conflicting skill file path: {path}", code="path_invalid"
                )
            paths.add(path)
            content = _require_string(file["content"], "skill file content", allow_empty=True)
            file_content_bytes = content.encode("utf-8")
            size_bytes = _require_int(file["sizeBytes"], "skill file size")
            if len(file_content_bytes) > MAX_SKILL_FILE_BYTES or size_bytes != len(
                file_content_bytes
            ):
                raise ManagedSkillsError(
                    f"invalid size for skill file {path}", code="installation_invalid"
                )
            digest = _validate_sha256(file["sha256"], "skill file SHA-256")
            if not hashlib.sha256(file_content_bytes).hexdigest() == digest:
                raise ManagedSkillsError(
                    f"SHA-256 mismatch for skill file {path}", code="hash_mismatch"
                )
            executable = file["executable"]
            if not isinstance(executable, bool):
                raise ManagedSkillsError(
                    f"invalid executable flag for {path}", code="installation_invalid"
                )
            if executable and not path.startswith("scripts/"):
                raise ManagedSkillsError(
                    f"executable skill file must be under scripts/: {path}", code="path_invalid"
                )
            revision_bytes += len(file_content_bytes)
            files.append(ManagedSkillFile(path, content, digest, size_bytes, executable))
        if "SKILL.md" not in paths:
            raise ManagedSkillsError(
                f"managed skill {name} has no SKILL.md", code="installation_invalid"
            )
        skill_markdown = next(file.content for file in files if file.path == "SKILL.md")
        if _canonical_frontmatter_name(skill_markdown) != name:
            raise ManagedSkillsError(
                f"SKILL.md name does not match managed skill {name}", code="installation_invalid"
            )
        if revision_bytes > MAX_SKILL_REVISION_BYTES:
            raise ManagedSkillsError(
                f"invalid total size for managed skill {name}", code="installation_invalid"
            )
        installation_content_bytes += revision_bytes
        skills.append(ManagedSkill(name, tuple(files)))

    if installation_content_bytes > MAX_MANAGED_SKILL_MANIFEST_BYTES:
        raise ManagedSkillsError(
            "managed skills content exceeds the session size limit", code="installation_too_large"
        )

    # A page that promises more must deliver something. Without this a control
    # plane could hand back empty pages and an advancing cursor forever; with
    # it, every non-final page adds at least one skill, every skill adds a
    # non-empty SKILL.md to the content aggregate, and the 5 MiB check above
    # therefore terminates the traversal. A repeated page terminates earlier
    # still, on the duplicate-name check.
    if next_cursor is not None and not skills:
        raise ManagedSkillsError(
            "managed skills page is empty but claims more", code="installation_invalid"
        )

    page = ManagedSkillInstallationPage(manifest_sha256, tuple(skills), next_cursor)
    return page, installation_content_bytes


def _canonical_frontmatter_name(markdown: str) -> str | None:
    if not markdown.startswith("---\n"):
        return None
    for line in markdown.splitlines()[1:]:
        if line == "---":
            return None
        match = _YAML_NAME_RE.fullmatch(line)
        if match:
            return next(value for value in match.groups() if value is not None)
    return None


def disables_model_invocation(markdown: str) -> bool:
    """Whether a generated SKILL.md carries ``disable-model-invocation: true``.

    The skill stays user-invocable (a slash command) but the model must not
    pick it on its own. Claude honours the key natively; OpenCode and Codex
    need it translated into their own controls.
    """
    if not markdown.startswith("---\n"):
        return False
    for line in markdown.splitlines()[1:]:
        if line == "---":
            return False
        if _DISABLE_MODEL_INVOCATION_RE.fullmatch(line):
            return True
    return False


def _read_skill_markdown(skill_dir: Path) -> str | None:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file() or skill_file.is_symlink():
        return None
    try:
        with skill_file.open("rb") as file:
            # The bound may split a character in the body; the frontmatter
            # comes first, so replacing that tail is harmless.
            return file.read(_SKILL_MARKDOWN_SCAN_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return None


def user_invoked_skill_dirs(skills_dir: Path) -> dict[str, Path]:
    """Installed skills under ``skills_dir`` that only a user may invoke, by name.

    Reads what the materializer installed, so a harness restart applies the
    same answer without the control plane.
    """
    if not skills_dir.is_dir():
        return {}
    found: dict[str, Path] = {}
    for child in skills_dir.iterdir():
        if child.name.startswith(".") or not child.is_dir() or child.is_symlink():
            continue
        markdown = _read_skill_markdown(child)
        if markdown is None or not disables_model_invocation(markdown):
            continue
        name = _canonical_frontmatter_name(markdown)
        if name and _SKILL_NAME_RE.fullmatch(name):
            found[name] = child
    return dict(sorted(found.items()))


def user_invoked_skill_names(skills_dir: Path) -> list[str]:
    """Names of the installed skills only a user may invoke, sorted."""
    return list(user_invoked_skill_dirs(skills_dir))


class ManagedSkillsMaterializer:
    """Install a fetched installation DTO into the platform-owned global skills directory.

    ``write_codex_invocation_policy`` writes Codex's ``agents/openai.yaml``
    explicit-only policy into skills that disable model invocation, merged
    into the author's file when there is one. It is written at install time,
    never stored, so revision digests are unaffected.

    ``extra_collision_roots`` are further skill directories the harness
    discovers (Codex's home and system skills), checked like the repository
    and home discovery paths.
    """

    def __init__(
        self,
        client: ManagedSkillsClient,
        destination: Path,
        log: Any,
        *,
        bundled_skills_path: Path = Path("/app/sandbox_runtime/skills"),
        write_codex_invocation_policy: bool = False,
        extra_collision_roots: Sequence[Path] = (),
    ) -> None:
        self.client = client
        self.destination = destination
        self.log = log
        self.bundled_skills_path = bundled_skills_path
        self.write_codex_invocation_policy = write_codex_invocation_policy
        self.extra_collision_roots = tuple(extra_collision_roots)

    @staticmethod
    def _remove_path(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)

    def _repair_interrupted_swap(self, staging: Path, backup: Path, journal: Path) -> None:
        """Restore the last complete tree or finish cleanup after an interrupted swap."""
        if not journal.exists():
            self._remove_path(staging)
            self._remove_path(backup)
            return
        if self.destination.exists() or self.destination.is_symlink():
            self._remove_path(backup)
        elif backup.exists() or backup.is_symlink():
            backup.rename(self.destination)
        self._remove_path(staging)
        journal.unlink(missing_ok=True)
        fsync_directory(self.destination.parent)

    @staticmethod
    def _skill_names(skill_dir: Path) -> set[str]:
        names = {skill_dir.name}
        skill_file = skill_dir / "SKILL.md"
        if skill_file.is_file() and not skill_file.is_symlink():
            try:
                with skill_file.open("rb") as file:
                    content = file.read(_SKILL_MARKDOWN_SCAN_BYTES)
                if content.startswith(b"---\n"):
                    for raw_line in content.splitlines()[1:]:
                        if raw_line == b"---":
                            break
                        line = raw_line.decode("utf-8")
                        match = _YAML_NAME_RE.match(line)
                        if match:
                            name = next(value for value in match.groups() if value is not None)
                            if _SKILL_NAME_RE.fullmatch(name):
                                names.add(name)
                            break
            except (OSError, UnicodeDecodeError):
                pass
        return names

    def _collision_roots(self, repositories: Sequence[RepoEntry], workdir: Path) -> Iterable[Path]:
        yield self.bundled_skills_path
        yield from self.extra_collision_roots
        bases = [workdir, *(repository.path for repository in repositories), Path.home()]
        seen: set[Path] = set()
        for base in bases:
            for relative in _DISCOVERY_PATHS:
                root = base / relative
                if root == self.destination or root in seen:
                    continue
                seen.add(root)
                yield root

    def _find_collisions(
        self,
        selected: AbstractSet[str],
        repositories: Sequence[RepoEntry],
        workdir: Path,
    ) -> dict[str, set[Path]]:
        """Collect managed names shadowed by an existing discovered skill."""
        found: dict[str, set[Path]] = {}
        for root in self._collision_roots(repositories, workdir):
            if not root.is_dir():
                continue
            for child in root.iterdir():
                # The destination may itself sit inside a discovery root
                # (Codex installs under ~/.agents/skills); neither it nor its
                # staging siblings are someone else's skill.
                if (
                    not child.is_dir()
                    or child == self.destination
                    or child.name.startswith(_STAGING_PREFIX)
                ):
                    continue
                for name in self._skill_names(child) & selected:
                    found.setdefault(name, set()).add(child)
        return found

    @staticmethod
    def _write_file(path: Path, file: ManagedSkillFile) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o500 if file.executable else 0o400)
        try:
            content = file.content.encode("utf-8")
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            if hashlib.sha256(path.read_bytes()).hexdigest() != file.sha256:
                raise ManagedSkillsError(
                    f"installed SHA-256 mismatch for {file.path}", code="install_failed"
                )
            os.fchmod(descriptor, 0o500 if file.executable else 0o400)
        finally:
            os.close(descriptor)

    def _begin_staging(self) -> tuple[Path, Path, Path]:
        """Recover any interrupted swap and open an empty staging tree."""
        parent = self.destination.parent
        parent.mkdir(parents=True, exist_ok=True)
        staging = parent / f"{_STAGING_PREFIX}staging"
        backup = parent / f"{_STAGING_PREFIX}backup"
        journal = parent / f"{_STAGING_PREFIX}swap"
        self._repair_interrupted_swap(staging, backup, journal)
        if self.destination.is_symlink() or (
            self.destination.exists() and not self.destination.is_dir()
        ):
            raise ManagedSkillsError(
                "managed skills destination is not a directory", code="install_failed"
            )
        staging.mkdir(mode=0o700)
        return staging, backup, journal

    def _stage_skills(self, staging: Path, skills: Sequence[ManagedSkill]) -> set[str]:
        """Write one batch of validated skills into the staging tree.

        Called once per fetched page, so peak memory is a page rather than the
        whole installation. Skill directories are created exclusively, which
        makes a duplicate name that slipped past validation fail here too.

        Returns the skills left out because they could not be installed as
        their frontmatter requires; the rest of the batch still installs.
        """
        dropped: set[str] = set()
        for skill in sorted(skills, key=lambda item: item.name.encode("utf-8")):
            skill_dir = staging / skill.name
            skill_dir.mkdir(mode=0o700)
            for file in sorted(skill.files, key=lambda item: item.path.encode("utf-8")):
                self._write_file(skill_dir / PurePosixPath(file.path), file)
            if self.write_codex_invocation_policy and not self._write_codex_invocation_policy(
                skill_dir, skill
            ):
                self._remove_path(skill_dir)
                dropped.add(skill.name)
        return dropped

    def _write_codex_invocation_policy(self, skill_dir: Path, skill: ManagedSkill) -> bool:
        """Keep a user-invoked-only skill out of Codex's implicit skill list.

        An authored ``agents/openai.yaml`` is kept with the policy merged in.
        Returns False when the policy file cannot be written (the skill ships a
        plain file at ``agents``, or a directory at the policy path): such a
        skill would be implicitly invocable, so it must not be installed.
        """
        markdown = next(file.content for file in skill.files if file.path == "SKILL.md")
        if not disables_model_invocation(markdown):
            return True
        target = skill_dir / PurePosixPath(CODEX_SKILL_POLICY_PATH)
        authored = next(
            (file for file in skill.files if file.path == CODEX_SKILL_POLICY_PATH), None
        )
        parent_blocked = target.parent.is_symlink() or (
            target.parent.exists() and not target.parent.is_dir()
        )
        target_blocked = authored is None and (target.exists() or target.is_symlink())
        if parent_blocked or target_blocked:
            self.log.warn(
                "managed_skills.codex_policy_unwritable",
                skill=skill.name,
                path=CODEX_SKILL_POLICY_PATH,
            )
            return False
        policy = explicit_only_policy(authored.content if authored else None)
        if policy.change == "kept":
            return True
        if authored is not None:
            self.log.info(
                "managed_skills.codex_policy_" + policy.change,
                skill=skill.name,
                path=CODEX_SKILL_POLICY_PATH,
            )
            target.unlink()
        content = policy.content.encode("utf-8")
        self._write_file(
            target,
            ManagedSkillFile(
                CODEX_SKILL_POLICY_PATH,
                policy.content,
                hashlib.sha256(content).hexdigest(),
                len(content),
                False,
            ),
        )
        return True

    def _commit_staging(self, staging: Path, backup: Path, journal: Path) -> None:
        """Swap the staged tree in, recoverably.

        The durable marker must precede moving the current tree. Recovery keeps
        an installed destination when present, or restores the backup otherwise.
        """
        parent = self.destination.parent
        atomic_write_private(journal, "")
        if self.destination.exists():
            self.destination.rename(backup)
            fsync_directory(parent)
        staging.rename(self.destination)
        fsync_directory(parent)
        self._remove_path(backup)
        journal.unlink(missing_ok=True)
        fsync_directory(parent)

    def _abort_staging(self, staging: Path, backup: Path, journal: Path) -> None:
        if not self.destination.exists() and backup.exists():
            backup.rename(self.destination)
        self._remove_path(staging)
        journal.unlink(missing_ok=True)

    def _install(self, installation: ManagedSkillInstallation) -> None:
        """Replace the complete managed tree from an already-assembled installation."""
        staging, backup, journal = self._begin_staging()
        try:
            self._stage_skills(staging, installation.skills)
            self._commit_staging(staging, backup, journal)
        except Exception:
            self._abort_staging(staging, backup, journal)
            raise

    async def _fetch_into_staging(self, staging: Path) -> tuple[str, set[str]]:
        """Stream every page into staging, returning the digest and installed names.

        Nothing outside the staging tree is touched until the caller commits, so
        a failure part-way through a paged fetch leaves the previous
        installation in place.

        The loop has no page-count bound on purpose. A fixed one would cap the
        installation at pages times page size, reintroducing exactly the kind of
        invented skill limit this work removed; the session contract bounds
        aggregate content, not count. Termination comes from that contract
        instead — see validate_installation_page.
        """
        names: set[str] = set()
        dropped: set[str] = set()
        content_bytes = 0
        manifest_sha256: str | None = None
        cursor: str | None = None
        while True:
            raw = await self.client.fetch_installation(
                cursor=cursor, limit=MANAGED_SKILLS_PAGE_SIZE
            )
            page, content_bytes = validate_installation_page(
                raw,
                names=names,
                content_bytes=content_bytes,
                expected_manifest_sha256=manifest_sha256,
            )
            manifest_sha256 = page.manifest_sha256
            dropped |= self._stage_skills(staging, page.skills)
            if page.next_cursor is None:
                # `names` keeps every fetched name for duplicate detection
                # across pages; only installed ones are reported.
                return manifest_sha256, names - dropped
            cursor = page.next_cursor

    async def materialize(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        """Fetch, validate, collision-check, and install skills before OpenCode starts."""
        try:
            staging, backup, journal = self._begin_staging()
            try:
                manifest_sha256, names = await self._fetch_into_staging(staging)
                collisions = self._find_collisions(names, repositories, workdir)
                if collisions:
                    for name in collisions:
                        self._remove_path(staging / name)
                    names.difference_update(collisions)
                    self.log.warn(
                        "managed_skills.collisions_dropped",
                        collisions=[
                            {
                                "name": name,
                                "paths": sorted(str(path) for path in collisions[name]),
                            }
                            for name in sorted(collisions)
                        ],
                    )
                self._commit_staging(staging, backup, journal)
            except Exception:
                self._abort_staging(staging, backup, journal)
                raise
        except ManagedSkillsError:
            raise
        except Exception as error:
            raise ManagedSkillsError(
                f"failed to install managed skills: {error}", code="install_failed"
            ) from error

        self.log.info(
            "managed_skills.materialized",
            manifest_sha256=manifest_sha256,
            skill_count=len(names),
        )
