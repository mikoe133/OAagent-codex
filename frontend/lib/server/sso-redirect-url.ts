export function createSsoRedirectUrl(request: Request, pathname: string): URL {
  const fallback = new URL(pathname, request.url)
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"))
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"))

  if (!forwardedHost || (forwardedProtocol !== "http" && forwardedProtocol !== "https")) {
    return fallback
  }

  try {
    const publicOrigin = new URL(`${forwardedProtocol}://${forwardedHost}`)
    if (
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.pathname !== "/" ||
      publicOrigin.search ||
      publicOrigin.hash
    ) {
      return fallback
    }

    return new URL(pathname, publicOrigin)
  } catch {
    return fallback
  }
}

function firstHeaderValue(value: string | null): string {
  return value?.split(",", 1)[0]?.trim() || ""
}
