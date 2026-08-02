import {
  MODEL_REASONING_EFFORTS,
  type AutomationModelParameters,
} from "../config/modelCatalog.js";

export type ProjectProgressRuntimeOptions = {
  writeMode: "dry-run" | "unsafe-test" | "production";
  observedAt: Date | null;
  projectId?: number;
  modelProvider?: string;
  modelId?: string;
  modelParameters?: AutomationModelParameters;
};

export function parseProjectProgressOptions(
  arguments_: string[],
): ProjectProgressRuntimeOptions {
  const dryRun = arguments_.includes("--dry-run");
  const applyTest = arguments_.includes("--apply-test");
  const apply = arguments_.includes("--apply");
  const selectedModes = [dryRun, applyTest, apply].filter(Boolean).length;
  if (selectedModes === 0) {
    throw new Error("必须选择 --dry-run、--apply-test 或 --apply。");
  }
  if (selectedModes > 1) {
    throw new Error("--dry-run、--apply-test 和 --apply 只能选择一个。");
  }

  let observedAt: Date | null = null;
  let projectId: number | undefined;
  let modelProvider: string | undefined;
  let modelId: string | undefined;
  const modelParameters: AutomationModelParameters = {};
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
    } else if (argument === "--model-provider") {
      modelProvider = requireOptionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--model") {
      modelId = requireOptionValue(arguments_, index, argument);
      index += 1;
    } else if (argument === "--model-reasoning-effort") {
      const value = requireOptionValue(arguments_, index, argument);
      if (!MODEL_REASONING_EFFORTS.some((effort) => effort === value)) {
        throw new Error(
          `--model-reasoning-effort 必须是 ${MODEL_REASONING_EFFORTS.join(", ")} 之一。`,
        );
      }
      modelParameters.reasoning_effort = value as AutomationModelParameters["reasoning_effort"];
      index += 1;
    } else if (argument === "--model-max-output-tokens") {
      const value = Number(requireOptionValue(arguments_, index, argument));
      if (!Number.isInteger(value) || value < 256 || value > 4_096) {
        throw new Error("--model-max-output-tokens 必须是 256-4096 的整数。");
      }
      modelParameters.max_output_tokens = value;
      index += 1;
    } else if (
      argument !== "--dry-run" &&
      argument !== "--apply-test" &&
      argument !== "--apply"
    ) {
      throw new Error(`未知参数:${argument}`);
    }
  }

  if (applyTest && projectId === undefined) {
    throw new Error("--apply-test 必须同时指定 --project-id。");
  }
  return {
    writeMode: apply ? "production" : applyTest ? "unsafe-test" : "dry-run",
    ...(projectId === undefined ? {} : { projectId }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(Object.keys(modelParameters).length === 0 ? {} : { modelParameters }),
    observedAt,
  };
}

function requireOptionValue(
  arguments_: string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} 必须指定值。`);
  }
  return value;
}
