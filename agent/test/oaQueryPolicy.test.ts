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
