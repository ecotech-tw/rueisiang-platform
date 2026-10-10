import { describe, expect, it } from "vitest";
import { addMinutes, hoursToMinutes, minutesToHours } from "./hours-entry.js";

describe("hoursToMinutes", () => {
  it("只接受 0.5 小時的正倍數", () => {
    expect(hoursToMinutes("0.5")).toBe(30);
    expect(hoursToMinutes(" 2 ")).toBe(120);
    expect(hoursToMinutes("1.5")).toBe(90);
  });

  it("空白、零、負數與不是 0.5 倍數的值都不算", () => {
    for (const text of ["", " ", "0", "-1", "0.25", "1.2", "abc"]) expect(hoursToMinutes(text)).toBeNull();
  });
});

describe("minutesToHours", () => {
  it("整數小時不帶小數點", () => {
    expect(minutesToHours(120)).toBe("2");
    expect(minutesToHours(90)).toBe("1.5");
  });
});

describe("addMinutes", () => {
  it("跨午夜與跨月都會進位", () => {
    expect(addMinutes("2026-01-31T22:30", 120)).toBe("2026-02-01T00:30");
  });

  it("開始時間還沒填完整時回空字串", () => {
    expect(addMinutes("", 60)).toBe("");
  });
});
