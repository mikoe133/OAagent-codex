import { createHash } from "node:crypto";

export const PROJECT_MAINTENANCE_AFTER_HOURS = 240;
export const ALLOWED_COMMIT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const PROJECT_PROGRESS_TIME_ZONE = "Asia/Shanghai";

export type ProjectStatus = "updating" | "maintenance" | "archived";

export type ProjectProgressCommit = {
  repositoryId: number;
  repositoryFullName: string;
  sha: string;
  committedAt: string;
  subject: string;
  files?: string[];
};

export type NormalizedProjectProgressCommit = ProjectProgressCommit & {
  activityAt: string;
  summaryDate: string;
  timestampAnomaly: boolean;
};

export type ProjectDailyCommitGroup = {
  summaryDate: string;
  commits: NormalizedProjectProgressCommit[];
  sourceDigest: string;
};

export type RepositoryActivityEvidence = {
  complete: boolean;
  lastActivityAt: string | null;
};

export type ProjectStatusDecision = {
  targetStatus: Exclude<ProjectStatus, "archived">;
  reason: "recent_activity" | "all_repositories_stale" | "incomplete_observation";
};

export function decideProjectStatus(input: {
  currentStatus: Exclude<ProjectStatus, "archived">;
  observedAt: Date;
  repositories: RepositoryActivityEvidence[];
}): ProjectStatusDecision {
  const threshold = input.observedAt.getTime() - PROJECT_MAINTENANCE_AFTER_HOURS * 60 * 60 * 1_000;
  const hasRecentActivity = input.repositories.some((repository) => {
    if (!repository.lastActivityAt) {
      return false;
    }
    const timestamp = Date.parse(repository.lastActivityAt);
    if (!Number.isFinite(timestamp)) {
      return false;
    }
    const safeTimestamp = timestamp > input.observedAt.getTime() + ALLOWED_COMMIT_CLOCK_SKEW_MS
      ? input.observedAt.getTime()
      : timestamp;
    return safeTimestamp > threshold;
  });

  if (hasRecentActivity) {
    return { targetStatus: "updating", reason: "recent_activity" };
  }
  if (input.repositories.length > 0 && input.repositories.every((repository) => repository.complete)) {
    return { targetStatus: "maintenance", reason: "all_repositories_stale" };
  }
  return {
    targetStatus: input.currentStatus,
    reason: "incomplete_observation",
  };
}

export function buildProjectDailyCommitGroups(
  commits: ProjectProgressCommit[],
  observedAt: Date,
  timeZone = PROJECT_PROGRESS_TIME_ZONE,
): ProjectDailyCommitGroup[] {
  const normalized = new Map<string, NormalizedProjectProgressCommit>();
  for (const commit of commits) {
    validateCommit(commit);
    const committedAt = Date.parse(commit.committedAt);
    const timestampAnomaly = committedAt > observedAt.getTime() + ALLOWED_COMMIT_CLOCK_SKEW_MS;
    const activityAt = timestampAnomaly ? observedAt.toISOString() : new Date(committedAt).toISOString();
    const key = `${commit.repositoryId}:${commit.sha}`;
    normalized.set(key, {
      ...commit,
      committedAt: new Date(committedAt).toISOString(),
      activityAt,
      summaryDate: formatDateInTimeZone(new Date(activityAt), timeZone),
      timestampAnomaly,
    });
  }

  const grouped = new Map<string, NormalizedProjectProgressCommit[]>();
  for (const commit of normalized.values()) {
    const dailyCommits = grouped.get(commit.summaryDate) ?? [];
    dailyCommits.push(commit);
    grouped.set(commit.summaryDate, dailyCommits);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([summaryDate, dailyCommits]) => {
      dailyCommits.sort(compareCommits);
      return {
        summaryDate,
        commits: dailyCommits,
        sourceDigest: createHash("sha256")
          .update(
            JSON.stringify(
              dailyCommits.map((commit) => ({
                repositoryId: commit.repositoryId,
                sha: commit.sha,
                committedAt: commit.committedAt,
                subject: commit.subject,
              })),
            ),
          )
          .digest("hex"),
      };
    });
}

function validateCommit(commit: ProjectProgressCommit): void {
  if (!Number.isInteger(commit.repositoryId) || commit.repositoryId < 1) {
    throw new Error("repositoryId 必须是正整数。");
  }
  if (!commit.repositoryFullName.trim() || !commit.sha.trim()) {
    throw new Error("repositoryFullName 和 sha 不能为空。");
  }
  if (!Number.isFinite(Date.parse(commit.committedAt))) {
    throw new Error(`committedAt 不是有效时间:${commit.committedAt}`);
  }
}

function compareCommits(
  left: NormalizedProjectProgressCommit,
  right: NormalizedProjectProgressCommit,
): number {
  return (
    left.repositoryId - right.repositoryId ||
    left.sha.localeCompare(right.sha) ||
    left.committedAt.localeCompare(right.committedAt)
  );
}

export function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
