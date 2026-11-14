export interface AuthRedirectLocation {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  assign(url: string): void;
}

function requestUrl(input: RequestInfo | URL, origin: string): URL {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(value, origin);
}

export function createAuthRedirectFetch(
  fetcher: typeof fetch,
  location: AuthRedirectLocation,
  apiBasePath = "/api",
): typeof fetch {
  let redirecting = false;
  const apiBase = new URL(apiBasePath, location.origin);
  const apiPrefix = `${apiBase.pathname.replace(/\/$/, "")}/`;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetcher(input, init);
    if (response.status !== 401 || redirecting || location.pathname === "/login") return response;

    const url = requestUrl(input, location.origin);
    if (url.origin !== apiBase.origin || !url.pathname.startsWith(apiPrefix)) return response;

    // 登入憑證錯誤與邀請連結失效也是預期的 401，應留在原表單顯示。
    const publicAuthPath = /\/auth\/(?:password|logout|invite(?:\/|$))/.test(url.pathname);
    if (publicAuthPath) return response;

    redirecting = true;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    return response;
  };
}
