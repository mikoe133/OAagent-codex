import { createHash } from "node:crypto";
import type { NormalizedProjectProgressCommit } from "./projectProgress.js";

export const REPOSITORY_EVIDENCE_SCHEMA_VERSION = "repository-evidence-v1" as const;
export const REPOSITORY_CANDIDATE_SELECTION_POLICY_VERSION =
  "repository-candidates-earliest-latest-v1" as const;

export type RepositoryEvidence = {
  schemaVersion: typeof REPOSITORY_EVIDENCE_SCHEMA_VERSION;
  repository: {
    id: number;
    fullName: string;
  };
  businessDate: string;
  commits: Array<{
    sha: string;
    committedAt: string;
    subject: string;
  }>;
};

export type RepositoryEvidenceEnvelope = {
  evidence: RepositoryEvidence;
  digest: string;
  candidateSelectionPolicyVersion:
    typeof REPOSITORY_CANDIDATE_SELECTION_POLICY_VERSION;
  omittedCommitCount: number;
};

export function buildRepositoryEvidence(input: {
  repositoryFullName: string;
  businessDate: string;
  commits: NormalizedProjectProgressCommit[];
  maxCommits: number;
}): RepositoryEvidenceEnvelope {
  const repositoryFullName = normalizeRepositoryFullName(input.repositoryFullName);
  validateBusinessDate(input.businessDate);
  if (!Number.isInteger(input.maxCommits) || input.maxCommits < 1) {
    throw new Error("maxCommits 必须是正整数。");
  }
  if (input.commits.length === 0) {
    throw new Error("RepositoryEvidence 至少需要一条 Commit。");
  }

  const normalized = input.commits.map((commit) => {
    if (normalizeRepositoryFullName(commit.repositoryFullName) !== repositoryFullName) {
      throw new Error("RepositoryEvidence 只能包含同一仓库的 Commit。");
    }
    if (!Number.isInteger(commit.repositoryId) || commit.repositoryId < 1) {
      throw new Error("RepositoryEvidence repository.id 必须是正整数。");
    }
    const committedAt = Date.parse(commit.committedAt);
    if (!Number.isFinite(committedAt)) {
      throw new Error("RepositoryEvidence committedAt 无效。");
    }
    const sha = commit.sha.trim().toLowerCase();
    if (!sha || sha.length > 64) {
      throw new Error("RepositoryEvidence sha 必须是 1-64 字符。");
    }
    return {
      repositoryId: commit.repositoryId,
      sha,
      committedAt: new Date(committedAt).toISOString(),
      subject: sanitizeSubject(commit.subject),
    };
  });
  const repositoryIds = new Set(normalized.map((commit) => commit.repositoryId));
  if (repositoryIds.size !== 1) {
    throw new Error("RepositoryEvidence 同一仓库必须使用一致的 repository.id。");
  }

  normalized.sort((left, right) =>
    left.sha.localeCompare(right.sha) ||
    left.committedAt.localeCompare(right.committedAt) ||
    left.subject.localeCompare(right.subject)
  );
  const commitsBySha = new Map<string, (typeof normalized)[number]>();
  for (const commit of normalized) {
    if (!commitsBySha.has(commit.sha)) {
      commitsBySha.set(commit.sha, commit);
    }
  }
  const uniqueCommits = [...commitsBySha.values()].sort((left, right) =>
    left.committedAt.localeCompare(right.committedAt) || left.sha.localeCompare(right.sha)
  );
  const selectedCommits = selectCandidates(uniqueCommits, input.maxCommits);
  const evidence: RepositoryEvidence = {
    schemaVersion: REPOSITORY_EVIDENCE_SCHEMA_VERSION,
    repository: {
      id: selectedCommits[0]!.repositoryId,
      fullName: repositoryFullName,
    },
    businessDate: input.businessDate,
    commits: selectedCommits.map((commit) => ({
      sha: commit.sha,
      committedAt: commit.committedAt,
      subject: commit.subject,
    })),
  };
  const canonicalDigestInput = {
    schemaVersion: evidence.schemaVersion,
    repositoryFullName: evidence.repository.fullName,
    businessDate: evidence.businessDate,
    commits: evidence.commits,
  };
  return {
    evidence,
    digest: createHash("sha256")
      .update(JSON.stringify(canonicalDigestInput))
      .digest("hex"),
    candidateSelectionPolicyVersion:
      REPOSITORY_CANDIDATE_SELECTION_POLICY_VERSION,
    omittedCommitCount: Math.max(0, uniqueCommits.length - selectedCommits.length),
  };
}

function selectCandidates<T>(commits: T[], maxCommits: number): T[] {
  if (commits.length <= maxCommits) {
    return commits;
  }
  const earliestCount = Math.ceil(maxCommits / 2);
  const latestCount = maxCommits - earliestCount;
  return [
    ...commits.slice(0, earliestCount),
    ...(latestCount > 0 ? commits.slice(-latestCount) : []),
  ];
}

function normalizeRepositoryFullName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized) || normalized.length > 255) {
    throw new Error("RepositoryEvidence repository.fullName 无效。");
  }
  return normalized;
}

function validateBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("RepositoryEvidence businessDate 必须是 YYYY-MM-DD。");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("RepositoryEvidence businessDate 不是有效日期。");
  }
}

function sanitizeSubject(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}
