/**
 * `SF_GITHUB_REPO_ALLOWLIST`: the repositories whose deliveries this bot acts
 * on, so a deployment can be pointed at GitHub one repository at a time.
 *
 * A comma-separated list of `owner/name`, compared case-insensitively. Unset
 * means no gate, which is the Worker's upstream behaviour; the Node entry
 * always sets it, so there an empty list denies every repository.
 */

export type RepoAllowlist = ReadonlySet<string>;

/** The allowlist an env value names, or null when the variable is unset. */
export function parseRepoAllowlist(raw: string | undefined): RepoAllowlist | null {
  if (raw === undefined) return null;
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "")
  );
}

/** Entries that are not `owner/name`; they can never match a delivery. */
export function invalidRepoAllowlistEntries(allowlist: RepoAllowlist): string[] {
  return [...allowlist].filter((entry) => !/^[^/\s]+\/[^/\s]+$/.test(entry));
}

/** Whether a delivery about `repo` (`owner/name`, any case; null when it names none) may proceed. */
export function isRepoAllowed(allowlist: RepoAllowlist | null, repo: string | null): boolean {
  if (allowlist === null) return true;
  return repo !== null && allowlist.has(repo.toLowerCase());
}
