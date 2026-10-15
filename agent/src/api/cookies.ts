/** Reads a cookie, removes transport quotes and URI-decodes its value once. */
export function parseCookie(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader || !cookieName) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) {
      continue;
    }

    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') || value.endsWith('"')) {
      if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
        return null;
      }
      value = value.slice(1, -1);
    }

    try {
      const decoded = decodeURIComponent(value);
      return decoded && !/[\u0000-\u001f\u007f;"]/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}
