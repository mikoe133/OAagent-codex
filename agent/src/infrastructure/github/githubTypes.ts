import type { ProjectProgressCommit } from "../../domain/projectProgress.js";
import type { GitHubRepositoryIdentity } from "./githubUrl.js";

export type GitHubRepositorySnapshot = {
  repositoryId: number;
  fullName: string;
  canonicalUrl: string;
  complete: boolean;
  lastActivityAt: string | null;
  commits: ProjectProgressCommit[];
};

export interface ProjectProgressGitHubReader {
  readRepository(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
  ): Promise<GitHubRepositorySnapshot>;
}
