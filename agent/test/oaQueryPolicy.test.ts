import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  beginOaTurn,
  finishOaTurn,
  recordOaApiCallResult,
  reserveOaApiCall,
  resolveOaQueryPolicy,
} from "../src/infrastructure/oa/oaQueryPolicy.js";

const activeSessions = new Set<string>();

afterEach(() => {
  for (const sessionId of activeSessions) {
    finishOaTurn(sessionId);
  }
  activeSessions.clear();
});

describe("OA dynamic query policy", () => {
  it("classifies exact Chinese-name and self lookups as single step", () => {
    assert.deepEqual(resolveOaQueryPolicy("查询薛屹阳的个人信息"), {
      mode: "single_step",
      exactPersonName: "薛屹阳",
    });
    assert.deepEqual(resolveOaQueryPolicy("王强资料"), {
      mode: "single_step",
      exactPersonName: "王强",
    });
    assert.deepEqual(resolveOaQueryPolicy("帮我查王强资料"), {
      mode: "single_step",
      exactPersonName: "王强",
    });
    assert.deepEqual(resolveOaQueryPolicy("查看我的个人信息"), {
      mode: "single_step",
      exactPersonName: null,
    });
  });

  it("classifies explicit Latin handles and emails as exact person lookups", () => {
    assert.deepEqual(resolveOaQueryPolicy("Ryan 是谁"), {
      mode: "single_step",
      exactPersonName: "Ryan",
    });
    assert.deepEqual(resolveOaQueryPolicy("谁是 Bo Peng？"), {
      mode: "single_step",
      exactPersonName: "Bo Peng",
    });
    assert.deepEqual(resolveOaQueryPolicy("查询 ryan@example.test 的个人信息"), {
      mode: "single_step",
      exactPersonName: "ryan@example.test",
    });
  });

  it("keeps reports, lists, writes, and chained queries multi step", () => {
    for (const task of [
      "查看我的本周周报",
      "列出全部在职员工",
      "统计各部门本月工时趋势",
      "查询薛屹阳的信息以及本周周报",
      "修改第 101 周周报",
      "维护项目 GitHub 仓库地址",
    ]) {
      assert.equal(resolveOaQueryPolicy(task).mode, "multi_step", task);
    }
  });

  it("leaves uncertain requests unrestricted instead of guessing single step", () => {
    assert.deepEqual(resolveOaQueryPolicy("查一下 Alpha 项目"), {
      mode: "unknown",
      exactPersonName: null,
    });
    assert.equal(resolveOaQueryPolicy("获取用户信息").mode, "unknown");
    assert.equal(resolveOaQueryPolicy("查看项目情况").mode, "unknown");
    assert.equal(resolveOaQueryPolicy("查询他的个人信息").mode, "unknown");
    assert.equal(resolveOaQueryPolicy("Ryan 有什么技能").mode, "unknown");
  });

  it("blocks a second call after a complete single-step result", () => {
    const sessionId = startTurn("complete", "薛屹阳信息");

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    recordOaApiCallResult(sessionId, {
      ok: true,
      data: { full_name: "薛屹阳", email: "xue@example.test" },
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, false);
  });

  it("upgrades a single-step turn when the first result is truncated or paginated", () => {
    const truncated = startTurn("truncated", "薛屹阳信息");
    assert.equal(reserveOaApiCall(truncated).allowed, true);
    recordOaApiCallResult(truncated, {
      ok: true,
      warnings: ["响应过大,已截断;需要更多数据时请分页继续查询。"],
      data: [],
    });
    assert.equal(reserveOaApiCall(truncated).allowed, true);
    assert.equal(reserveOaApiCall(truncated).allowed, true);

    const paginated = startTurn("paginated", "王强资料");
    assert.equal(reserveOaApiCall(paginated).allowed, true);
    recordOaApiCallResult(paginated, {
      ok: true,
      data: { total: 2, items: [{ full_name: "另一位用户" }] },
    });
    assert.equal(reserveOaApiCall(paginated).allowed, true);

    const unknownCoverage = startTurn("unknown-coverage", "赵敏资料");
    assert.equal(reserveOaApiCall(unknownCoverage).allowed, true);
    recordOaApiCallResult(unknownCoverage, {
      ok: true,
      coverage: { status: "unknown" },
      data: [{ full_name: "另一位用户" }],
    });
    assert.equal(reserveOaApiCall(unknownCoverage).allowed, true);
  });

  it("upgrades when a dependent identifier is missing", () => {
    const sessionId = startTurn("missing-id", "李雷信息");
    recordOaApiCallResult(sessionId, {
      ok: false,
      error: {
        code: "missing_required_parameter",
        message: "缺少用户 ID。",
      },
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    assert.equal(reserveOaApiCall(sessionId).allowed, true);
  });

  it("upgrades when a lookup only resolves an identifier and still needs details", () => {
    const sessionId = startTurn("dependent-detail", "韩梅梅个人信息");
    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    recordOaApiCallResult(sessionId, {
      ok: true,
      data: { id: 42, full_name: "韩梅梅" },
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    assert.equal(reserveOaApiCall(sessionId).allowed, true);
  });

  it("recovers from an irrelevant result and stops again after an exact identity match", () => {
    const sessionId = startTurn("reconverge", "Ryan 是谁");

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    recordOaApiCallResult(sessionId, {
      ok: true,
      identityMatch: {
        query: "Ryan",
        status: "insufficient",
        scannedCandidates: 0,
        matched: 0,
      },
      data: [{ category: "产品", user_id_list: [1, 25] }],
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    recordOaApiCallResult(sessionId, {
      ok: true,
      identityMatch: {
        query: "Ryan",
        status: "matched",
        scannedCandidates: 30,
        matched: 1,
        matchedBy: [{ itemIndex: 0, fields: ["username", "wx_name"] }],
      },
      data: {
        user_id: 25,
        username: "Ryan",
        full_name: "罗鑫",
        department: "产品部",
        employee_title: "全栈",
      },
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, false);
  });

  it("does not treat a complete scoped non-match as directory-wide absence", () => {
    const sessionId = startTurn("scoped-non-match", "Ryan 是谁");

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
    recordOaApiCallResult(sessionId, {
      ok: true,
      coverage: { status: "complete" },
      identityMatch: {
        query: "Ryan",
        status: "not_found",
        scannedCandidates: 1,
        matched: 0,
      },
      data: {
        user_id: 1,
        username: "Current User",
        full_name: "当前用户",
      },
    });

    assert.equal(reserveOaApiCall(sessionId).allowed, true);
  });

  it("bounds recovery attempts for a simple identity lookup", () => {
    const sessionId = startTurn("bounded-recovery", "Ryan 是谁");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(reserveOaApiCall(sessionId).allowed, true);
      recordOaApiCallResult(sessionId, {
        ok: true,
        identityMatch: {
          query: "Ryan",
          status: "insufficient",
          scannedCandidates: 0,
          matched: 0,
        },
        data: { message: "该接口不包含人员身份记录" },
      });
    }

    assert.equal(reserveOaApiCall(sessionId).allowed, false);
  });

  it("never hard-limits multi-step or unknown turns", () => {
    for (const [suffix, task] of [
      ["multi", "查看我的本周周报"],
      ["unknown", "查一下 Alpha 项目"],
    ]) {
      const sessionId = startTurn(suffix, task);
      assert.equal(reserveOaApiCall(sessionId).allowed, true);
      assert.equal(reserveOaApiCall(sessionId).allowed, true);
      assert.equal(reserveOaApiCall(sessionId).allowed, true);
    }
  });
});

function startTurn(suffix: string, task: string): string {
  const sessionId = `test-${suffix}`;
  activeSessions.add(sessionId);
  beginOaTurn(sessionId, resolveOaQueryPolicy(task));
  return sessionId;
}
