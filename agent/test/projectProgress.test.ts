import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildProjectDailyCommitGroups,
  decideProjectStatus,
} from "../src/domain/projectProgress.js";

const observedAt = new Date("2026-07-24T12:00:00.000Z");

describe("decideProjectStatus", () => {
  it("keeps activity inside 240 hours updating", () => {
    assert.equal(
      decideProjectStatus({
        currentStatus: "maintenance",
        observedAt,
        repositories: [
          {
            complete: true,
            lastActivityAt: "2026-07-14T12:00:01.000Z",
          },
        ],
      }).targetStatus,
      "updating",
    );
  });

  it("changes a fully observed project to maintenance at 240 hours", () => {
    assert.equal(
      decideProjectStatus({
        currentStatus: "updating",
        observedAt,
        repositories: [
          {
            complete: true,
            lastActivityAt: "2026-07-14T12:00:00.000Z",
          },
        ],
      }).targetStatus,
      "maintenance",
    );
  });

  it("does not downgrade when any repository failed", () => {
    assert.equal(
      decideProjectStatus({
        currentStatus: "updating",
        observedAt,
        repositories: [
          {
            complete: true,
            lastActivityAt: "2026-07-01T00:00:00.000Z",
          },
          { complete: false, lastActivityAt: null },
        ],
      }).targetStatus,
      "updating",
    );
  });
});

describe("buildProjectDailyCommitGroups", () => {
  it("aggregates repositories into one project/date group", () => {
    const groups = buildProjectDailyCommitGroups(
      [
        commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z"),
        commit(2, "alpha/web", "b", "2026-07-24T11:00:00.000Z"),
        commit(1, "alpha/api", "a", "2026-07-24T01:00:00.000Z"),
      ],
      observedAt,
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.summaryDate, "2026-07-24");
    assert.deepEqual(groups[0]?.commits.map((item) => item.sha), ["a", "b"]);
    assert.match(groups[0]?.sourceDigest ?? "", /^[a-f0-9]{64}$/);
  });

  it("uses observation time for future timestamps", () => {
    const groups = buildProjectDailyCommitGroups(
      [commit(1, "alpha/api", "future", "2026-07-25T12:00:00.000Z")],
      observedAt,
    );

    assert.equal(groups[0]?.summaryDate, "2026-07-24");
    assert.equal(groups[0]?.commits[0]?.timestampAnomaly, true);
    assert.equal(groups[0]?.commits[0]?.activityAt, observedAt.toISOString());
  });
});

function commit(
  repositoryId: number,
  repositoryFullName: string,
  sha: string,
  committedAt: string,
) {
  return {
    repositoryId,
    repositoryFullName,
    sha,
    committedAt,
    subject: `commit ${sha}`,
  };
}
