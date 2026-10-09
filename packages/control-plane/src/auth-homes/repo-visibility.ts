import type { SourceControlProvider } from "../source-control/types";
import { createLogger } from "../logger";

const logger = createLogger("auth-homes:repo-visibility");

/**
 * Whether every repository of a session is private, asked of the provider
 * at create and at child spawn. A session without repositories touches no
 * public repository and counts as private. Any repository the provider does
 * not report as private, or a failed lookup, fails closed (false / null).
 */
export async function repositoriesArePrivate(
  provider: Pick<SourceControlProvider, "checkRepositoryAccess">,
  repositories: readonly { repoOwner: string; repoName: string }[]
): Promise<boolean | null> {
  try {
    for (const repository of repositories) {
      const access = await provider.checkRepositoryAccess({
        owner: repository.repoOwner,
        name: repository.repoName,
      });
      if (access?.isPrivate !== true) return false;
    }
    return true;
  } catch (e) {
    logger.warn("auth_home.repo_visibility_unknown", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
