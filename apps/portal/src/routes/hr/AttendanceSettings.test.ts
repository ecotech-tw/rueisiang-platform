import { describe, expect, it } from "vitest";
import { radiusForSave } from "./AttendanceSettings.js";

describe("辦公位置送出的半徑", () => {
  it("關閉定位時，被藏起來的無效半徑改用原本存著的值", () => {
    expect(radiusForSave({ geolocationRequired: false, radiusMeters: "" }, 120)).toBe(120);
    expect(radiusForSave({ geolocationRequired: false, radiusMeters: "0" }, 120)).toBe(120);
    expect(radiusForSave({ geolocationRequired: false, radiusMeters: "abc" })).toBe(50);
  });

  it("關閉定位但半徑有效時照填的送；開著定位時不替使用者改值", () => {
    expect(radiusForSave({ geolocationRequired: false, radiusMeters: "80" }, 120)).toBe(80);
    expect(radiusForSave({ geolocationRequired: true, radiusMeters: "80" }, 120)).toBe(80);
    expect(radiusForSave({ geolocationRequired: true, radiusMeters: "" }, 120)).toBe(0);
  });
});
