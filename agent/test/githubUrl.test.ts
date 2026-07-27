import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGitHubRepositoryUrl } from "../src/infrastructure/github/githubUrl.js";

describe("normalizeGitHubRepositoryUrl", () => {
  it("normalizes supported repository URLs", () => {
    assert.deepEqual(
      normalizeGitHubRepositoryUrl("https://github.com/OpenAI/codex.git/"),
      {
        owner: "OpenAI",
        repository: "codex",
        fullName: "OpenAI/codex",
        canonicalUrl: "https://github.com/OpenAI/codex",
      },
    );
  });

  it("rejects non-GitHub hosts and non-repository paths", () => {
    for (const value of [
      "https://github.example.com/openai/codex",
      "https://github.com/openai/codex/issues",
      "https://github.com/openai/codex?tab=readme",
      "https://user@github.com/openai/codex",
      "git@github.com:openai/codex.git",
    ]) {
      assert.throws(() => normalizeGitHubRepositoryUrl(value));
    }
  });
});
