import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGooglePlaces } from "./google-maps.js";

afterEach(() => vi.unstubAllGlobals());

describe("Google Maps 地點搜尋", () => {
  it("只回傳畫面選點所需的地點與經緯度", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      places: [
        {
          id: "place-1",
          displayName: { text: "測試櫃點" },
          formattedAddress: "臺北市中正區測試路 1 號",
          location: { latitude: 25.033, longitude: 121.5654 },
        },
        { id: "incomplete", displayName: { text: "缺座標地點" }, formattedAddress: "臺灣" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const places = await searchGooglePlaces("測試櫃點", "test-api-key");

    expect(places).toEqual([{
      id: "place-1",
      name: "測試櫃點",
      address: "臺北市中正區測試路 1 號",
      latitude: 25.033,
      longitude: 121.5654,
    }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Goog-Api-Key")).toBe("test-api-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({ textQuery: "測試櫃點", languageCode: "zh-TW", regionCode: "TW" });
  });
});
