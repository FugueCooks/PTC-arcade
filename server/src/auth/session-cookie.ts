export function readSessionCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader || cookieHeader.length > 8_192) return undefined;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,256}$/.test(value) ? value : undefined;
  }
  return undefined;
}
