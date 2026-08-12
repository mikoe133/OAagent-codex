import type { ModelReasoningEffort } from "@openai/codex-sdk";

const STATISTICS_PATTERN =
  /统计|汇总|趋势|同比|环比|占比|排名|分布|平均|总计|报表分析|数据分析/i;
const CROSS_MODULE_PATTERN =
  /跨模块|跨系统|跨部门|综合分析|关联分析|结合.+(?:分析|判断)|(?:项目|周报|工时|人员|考勤|审批).+(?:项目|周报|工时|人员|考勤|审批).+(?:分析|风险|趋势)/i;
const WRITE_PATTERN =
  /(?:帮我|请|需要|执行|确认)?\s*(?:新增|创建|添加|增加|修改|更新|编辑|维护|配置|设置|补充|替换|清空|删除|移除|保存|提交|上传|导入|审批|通过|驳回|拒绝|重置|变更|写入|发布|归档|恢复|分配|调整)/i;

export function resolveTaskReasoningEffort(task: string): ModelReasoningEffort {
  const normalized = task.trim();
  if (
    STATISTICS_PATTERN.test(normalized) ||
    CROSS_MODULE_PATTERN.test(normalized) ||
    WRITE_PATTERN.test(normalized)
  ) {
    return "high";
  }
  return "medium";
}
