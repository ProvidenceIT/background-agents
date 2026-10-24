-- Repository ownership (W1-ownership-model): the owning team, criticality
-- tier, repository class, domain and dependencies, plus the rules the
-- repository's CODEOWNERS file names, mirrored by the daily sync.
-- repo_class is nullable on purpose: every consumer treats NULL as 'client'
-- (effectiveRepoClass in @open-inspect/shared), so an unclassified
-- repository never qualifies for a policy reserved for internal or
-- playground repositories. depends_on and codeowners are JSON built in
-- TypeScript; codeowners stays NULL when the repository has no CODEOWNERS
-- file, and codeowners_synced_at is NULL until the first successful sync.

ALTER TABLE repo_metadata ADD COLUMN owner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE repo_metadata ADD COLUMN tier TEXT CHECK (tier IN ('T1', 'T2', 'T3'));
ALTER TABLE repo_metadata ADD COLUMN repo_class TEXT CHECK (repo_class IN ('playground', 'internal', 'client'));
ALTER TABLE repo_metadata ADD COLUMN domain TEXT;
ALTER TABLE repo_metadata ADD COLUMN depends_on TEXT;
ALTER TABLE repo_metadata ADD COLUMN codeowners TEXT;
ALTER TABLE repo_metadata ADD COLUMN codeowners_synced_at INTEGER;
