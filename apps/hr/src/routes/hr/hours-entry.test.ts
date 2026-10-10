import { describe, expect, it } from "vitest";
import { hoursToMinutes } from "./hours-entry.js";

describe("hoursToMinutes", () => {
  it("只接受 0.5 小時的正倍數", () => {
    expect(hoursToMinutes("0.5")).toBe(30);
    expect(hoursToMinutes(" 2 ")).toBe(120);
    expect(hoursToMinutes("1.5")).toBe(90);
  });

  it("空白、零、負數與不是 0.5 倍數的值都不算", () => {
    for (const text of ["", " ", "0", "-1", "0.25", "1.2", "abc"]) expect(hoursToMinutes(text)).toBeNull();
  });

  it("超過 31 天的時數不算，日期才不會被推出可表示的範圍", () => {
    expect(hoursToMinutes("744")).toBe(44_640);
    for (const text of ["744.5", "9999999999", "1e10"]) expect(hoursToMinutes(text)).toBeNull();
  });
});
