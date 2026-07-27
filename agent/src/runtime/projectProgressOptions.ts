export type ProjectProgressRuntimeOptions = {
  writeMode: "dry-run" | "unsafe-test";
  observedAt: Date | null;
  projectId?: number;
};

export function parseProjectProgressOptions(
  arguments_: string[],
): ProjectProgressRuntimeOptions {
  const dryRun = arguments_.includes("--dry-run");
  const applyTest = arguments_.includes("--apply-test");
  if (!dryRun && !applyTest) {
    throw new Error("必须选择 --dry-run 或 --apply-test。");
  }
  if (dryRun && applyTest) {
    throw new Error("--dry-run 和 --apply-test 只能选择一个。");
  }

  let observedAt: Date | null = null;
  let projectId: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--observed-at") {
      const value = arguments_[index + 1] ?? "";
      observedAt = new Date(value);
      if (!Number.isFinite(observedAt.getTime())) {
        throw new Error(`--observed-at 无效:${value}`);
      }
      index += 1;
    } else if (argument === "--project-id") {
      const value = Number(arguments_[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--project-id 必须是正整数。");
      }
      projectId = value;
      index += 1;
    } else if (argument !== "--dry-run" && argument !== "--apply-test") {
      throw new Error(`未知参数:${argument}`);
    }
  }

  if (applyTest && projectId === undefined) {
    throw new Error("--apply-test 必须同时指定 --project-id。");
  }
  return {
    writeMode: applyTest ? "unsafe-test" : "dry-run",
    ...(projectId === undefined ? {} : { projectId }),
    observedAt,
  };
}
