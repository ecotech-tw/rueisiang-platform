export interface CookieOptions {
  maxAge: number;
  path?: string;
  domain?: string;
}

/** 一律 HttpOnly + Secure + SameSite=Lax；跨子網域部署時才設定 domain。 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const path = options.path ?? "/";
  const domain = options.domain ? `; Domain=${options.domain}` : "";
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${options.maxAge}${domain}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path = "/", domain?: string): string {
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  return `${name}=; Path=${path}; Max-Age=0${domainAttribute}; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
