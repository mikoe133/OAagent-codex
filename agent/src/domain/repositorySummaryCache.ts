export type CachedRepositorySummary = {
  summary: string;
  limitations: string[];
};

export interface RepositorySummaryCache {
  getRepositorySummaryCache(identityDigest: string): CachedRepositorySummary | null;
  putRepositorySummaryCache(input: {
    identityDigest: string;
    evidenceDigest: string;
    summary: string;
    limitations: string[];
  }): void;
}
