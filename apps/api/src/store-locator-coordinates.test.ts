import { projectStoreLocatorPin, STORE_LOCATOR_PIN_BOUNDS } from "@rueisiang/db/store-locator-coordinates";
import { describe, expect, it } from "vitest";

describe("據點底圖 Mercator 校準", () => {
  it("符合原圖校準點，不把 viewBox 當經緯度範圍", () => {
    const pin = projectStoreLocatorPin(120.328758, 23.874448)!;
    expect(pin.x).toBeCloseTo(535.3, 1);
    expect(pin.y).toBeCloseTo(549.3, 1);
  });

  it.each([
    { name: "中和環球", longitude: 121.474806, latitude: 25.007169, x: 752.5, y: 313.5 },
    { name: "夢時代舊公式座標對應地點", longitude: 120.30550684931507, latitude: 22.59474125874126, x: 530.9, y: 813.2 },
  ])("$name 使用原圖校準後的座標", ({ longitude, latitude, x, y }) => {
    const pin = projectStoreLocatorPin(longitude, latitude)!;
    expect(Number(pin.x.toFixed(1))).toBe(x);
    expect(Number(pin.y.toFixed(1))).toBe(y);
  });

  it("支援原先 X=840 限制外的本島東北端", () => {
    const pin = projectStoreLocatorPin(122, 25)!;
    expect(pin.x).toBeGreaterThan(840);
    expect(pin.x).toBeLessThanOrEqual(STORE_LOCATOR_PIN_BOUNDS.x.max);
    expect(pin.y).toBeGreaterThanOrEqual(STORE_LOCATOR_PIN_BOUNDS.y.min);
    expect(pin.y).toBeLessThanOrEqual(STORE_LOCATOR_PIN_BOUNDS.y.max);
  });

  it("同經度維持同 X，緯度愈北 Y 愈小", () => {
    const north = projectStoreLocatorPin(121, 25)!;
    const south = projectStoreLocatorPin(121, 23)!;
    expect(north.x).toBe(south.x);
    expect(north.y).toBeLessThan(south.y);
  });

  it.each([[NaN, 23], [121, Infinity], [139.7, 35.6], [118.4, 24.4], [121, 26]])("範圍外或無效座標 %s,%s 不產生圖釘", (longitude, latitude) => {
    expect(projectStoreLocatorPin(longitude, latitude)).toBeNull();
  });
});
