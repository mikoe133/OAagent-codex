import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRepositoryEvidence,
  REPOSITORY_EVIDENCE_SCHEMA_VERSION,
} from "../src/domain/projectProgressEvidence.js";

describe("buildRepositoryEvidence", () => {
  it("whitelists, sorts, deduplicates, and hashes repository evidence canonically", () => {
    const forward = buildRepositoryEvidence({
      repositoryFullName: "Example/API",
      businessDate: "2026-08-07",
      commits: [
        commit("bbbbbbbb", "2026-08-07T02:00:00.000Z", " second\u0000 title "),
        commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "first title"),
        commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "first title"),
      ],
      maxCommits: 50,
    });
    const reversed = buildRepositoryEvidence({
      repositoryFullName: "example/api",
      businessDate: "2026-08-07",
      commits: [
        commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "first title"),
        commit("bbbbbbbb", "2026-08-07T02:00:00.000Z", " second\u0000 title "),
      ].reverse(),
      maxCommits: 50,
    });

    assert.equal(forward.evidence.schemaVersion, REPOSITORY_EVIDENCE_SCHEMA_VERSION);
    assert.deepEqual(forward.evidence, {
      schemaVersion: "repository-evidence-v1",
      repository: { id: 7, fullName: "example/api" },
      businessDate: "2026-08-07",
      commits: [
        {
          sha: "aaaaaaaa",
          committedAt: "2026-08-07T01:00:00.000Z",
          subject: "first title",
        },
        {
          sha: "bbbbbbbb",
          committedAt: "2026-08-07T02:00:00.000Z",
          subject: "second title",
        },
      ],
    });
    assert.equal(forward.digest, reversed.digest);
    assert.match(forward.digest, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(forward.evidence), /files|activityAt|summaryDate/);
  });

  it("truncates candidates only after canonical ordering", () => {
    const result = buildRepositoryEvidence({
      repositoryFullName: "example/api",
      businessDate: "2026-08-07",
      commits: [
        commit("cccccccc", "2026-08-07T03:00:00.000Z", "c"),
        commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "a"),
        commit("bbbbbbbb", "2026-08-07T02:00:00.000Z", "b"),
      ],
      maxCommits: 2,
    });

    assert.deepEqual(result.evidence.commits.map((item) => item.sha), [
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
    assert.equal(result.omittedCommitCount, 1);
  });

  it("rejects mixed repositories and invalid business dates", () => {
    assert.throws(
      () => buildRepositoryEvidence({
        repositoryFullName: "example/api",
        businessDate: "2026/08/07",
        commits: [commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "a")],
        maxCommits: 50,
      }),
      /businessDate/,
    );
    assert.throws(
      () => buildRepositoryEvidence({
        repositoryFullName: "example/api",
        businessDate: "2026-08-07",
        commits: [{
          ...commit("aaaaaaaa", "2026-08-07T01:00:00.000Z", "a"),
          repositoryFullName: "example/web",
        }],
        maxCommits: 50,
      }),
      /同一仓库/,
    );
  });
});

function commit(sha: string, committedAt: string, subject: string) {
  return {
    repositoryId: 7,
    repositoryFullName: "example/api",
    sha,
    committedAt,
    subject,
    files: ["secret-file-that-must-not-enter-evidence.ts"],
    activityAt: committedAt,
    summaryDate: "2026-08-07",
    timestampAnomaly: false,
  };
}
