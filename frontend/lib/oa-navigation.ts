export const TEST_OA_NAVIGATION_URL = "https://rwkv-oa.vercel.app/"
export const PRODUCTION_OA_NAVIGATION_URL = "https://oa.rwkvos.com/"

const PRODUCTION_OA_HOSTNAMES = new Set(["api-oa.rwkvos.com", "oa.rwkvos.com"])

export function resolveOaNavigationUrl(value: string | null | undefined): string {
  const candidate = value?.trim()
  if (!candidate) {
    return TEST_OA_NAVIGATION_URL
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return TEST_OA_NAVIGATION_URL
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return TEST_OA_NAVIGATION_URL
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (PRODUCTION_OA_HOSTNAMES.has(hostname)) {
    return PRODUCTION_OA_NAVIGATION_URL
  }

  return TEST_OA_NAVIGATION_URL
}
