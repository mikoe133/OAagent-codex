export type GitHubRepositoryIdentity = {
  owner: string;
  repository: string;
  fullName: string;
  canonicalUrl: string;
};

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function normalizeGitHubRepositoryUrl(value: string): GitHubRepositoryIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GitHub 仓库地址无效:${value}`);
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`只接受 github.com 的 HTTP(S) 仓库地址:${value}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error(`GitHub 地址必须只包含 owner/repository:${value}`);
  }
  const owner = segments[0] ?? "";
  const repository = (segments[1] ?? "").replace(/\.git$/i, "");
  if (
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    throw new Error(`GitHub owner 或 repository 无效:${value}`);
  }

  return {
    owner,
    repository,
    fullName: `${owner}/${repository}`,
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  };
}
