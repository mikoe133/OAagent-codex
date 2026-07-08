import { readFileSync } from "node:fs";
import path from "node:path";

/** 固定读取顺序,系统提示词始终在最前。 */
const PROMPT_FILES = [
  "system.md",
  "document-policy.md",
  "output-policy.md",
] as const;

/**
 * 按固定顺序读取 prompts/*.md 并拼接为一段系统提示词。
 * 任一文件缺失时直接报错,不做降级。
 */
export function loadSystemPrompt(projectRoot: string): string {
  const sections = PROMPT_FILES.map((fileName) => {
    const filePath = path.join(projectRoot, "prompts", fileName);
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `缺少提示词文件:${filePath}。prompts/ 下必须包含 ${PROMPT_FILES.join("、")}。`,
          { cause: error },
        );
      }
      throw error;
    }
  });
  return sections.join("\n\n");
}
