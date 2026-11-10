import { afterEach, describe, expect, it, vi } from "vitest";
import { cyberbizClient, cyberbizInventoryClient } from "./cyberbiz.js";

const apiToken = "cyberbiz-api-secret";
const relayToken = "relay-shared-secret";

afterEach(() => vi.unstubAllGlobals());

describe("CYBERBIZ NAS relay 設定", () => {
  it("透過設定好的 relay 轉送 API 與獨立的 relay token", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ customers: [] }), { status: 200 });
    });

    const client = cyberbizClient({
      CYBERBIZ_API_TOKEN: apiToken,
      CYBERBIZ_API_RELAY_URL: "https://cyberbiz-relay.rueisiang.com",
      CYBERBIZ_API_RELAY_TOKEN: relayToken,
    } as never);
    await client?.fetchPage(1, 5);

    expect(requestUrl).toBe("https://cyberbiz-relay.rueisiang.com/v1/customers?page=1&per_page=5");
    expect(requestHeaders?.get("authorization")).toBe(`Bearer ${apiToken}`);
    expect(requestHeaders?.get("x-cyberbiz-relay-token")).toBe(relayToken);
  });

  it("relay URL 與 token 必須成對設定，避免未授權的直連 fallback", () => {
    expect(() => cyberbizClient({
      CYBERBIZ_API_TOKEN: apiToken,
      CYBERBIZ_API_RELAY_URL: "https://cyberbiz-relay.example.test",
    } as never)).toThrow("CYBERBIZ_API_RELAY_URL 與 CYBERBIZ_API_RELAY_TOKEN 必須同時設定。");

    expect(() => cyberbizInventoryClient({
      CYBERBIZ_API_TOKEN: apiToken,
      CYBERBIZ_API_RELAY_TOKEN: relayToken,
    } as never)).toThrow("CYBERBIZ_API_RELAY_URL 與 CYBERBIZ_API_RELAY_TOKEN 必須同時設定。");
  });

  it("relay endpoint 必須使用 HTTPS，localhost 僅供本機測試", () => {
    expect(() => cyberbizClient({
      CYBERBIZ_API_TOKEN: apiToken,
      CYBERBIZ_API_RELAY_URL: "http://relay.example.test",
      CYBERBIZ_API_RELAY_TOKEN: relayToken,
    } as never)).toThrow("CYBERBIZ_API_RELAY_URL 必須是受信任的 HTTPS origin。");
  });
});
