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

export type GitHubRepositoryReadProgress = {
  branchesCompleted: number;
  branchesTotal: number | null;
  commitsRead: number;
};

export type GitHubRepositoryReadProgressSink = (
  progress: GitHubRepositoryReadProgress,
) => void | Promise<void>;

export interface ProjectProgressGitHubReader {
  readRepository(
    repository: GitHubRepositoryIdentity,
    observedAt: Date,
    signal?: AbortSignal,
    onProgress?: GitHubRepositoryReadProgressSink,
  ): Promise<GitHubRepositorySnapshot>;
}
