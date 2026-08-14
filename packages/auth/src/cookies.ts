export interface CookieOptions {
  maxAge: number;
  path?: string;
}

/** 一律 HttpOnly + Secure + SameSite=Lax：SPA 不需要用 JS 讀 session。 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const path = options.path ?? "/";
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${options.maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path = "/"): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
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
