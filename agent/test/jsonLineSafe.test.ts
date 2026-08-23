import assert from "node:assert/strict";
import { Readable } from "node:stream";
import readline from "node:readline";
import { describe, it } from "node:test";
import { stringifyJsonLineSafe } from "../scripts/jsonLineSafe.mjs";
import { normalizeJsonLineSeparators } from "../src/infrastructure/codex/jsonLineSafety.js";

describe("JSONL-safe command output", () => {
  it("normalizes Unicode record separators before downstream JSON filters", () => {
    assert.equal(
      normalizeJsonLineSeparators("第一行\u2028第二行\u2029第三行"),
      "第一行\n第二行\n第三行",
    );
  });

  it("escapes Unicode line separators without changing the decoded data", async () => {
    const value = {
      content: "抬头：上海元我智能科技有限公司\u2028纳税人识别号\u2029开户地址",
    };

    const commandOutput = stringifyJsonLineSafe(value, 2);

    assert.doesNotMatch(commandOutput, /[\u2028\u2029]/u);
    assert.match(commandOutput, /\\u2028/);
    assert.match(commandOutput, /\\u2029/);

    const event = `${JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        aggregated_output: commandOutput,
      },
    })}\n`;
    const lines: string[] = [];
    const reader = readline.createInterface({
      input: Readable.from([event]),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      lines.push(line);
    }

    assert.equal(lines.length, 1);
    const parsedEvent = JSON.parse(lines[0]!) as {
      item: { aggregated_output: string };
    };
    assert.deepEqual(JSON.parse(parsedEvent.item.aggregated_output), value);
  });
});
