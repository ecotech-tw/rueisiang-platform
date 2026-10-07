import { describe, expect, it } from "vitest";
import { addMinutes, hoursText, isValidOvertimeMinutes, minutesUntil, monthRange, nextDate, parseHours, summarizeAssignments } from "./overtime-entry.js";

describe("加班時數與結束時間互相換算", () => {
  it("由時數推出結束時間，跨午夜會進到隔天", () => {
    expect(addMinutes("2026-10-07T20:00", 30)).toBe("2026-10-07T20:30");
    expect(addMinutes("2026-10-31T23:30", 60)).toBe("2026-11-01T00:30");
    expect(addMinutes("不是時間", 30)).toBe("");
  });

  it("由結束時間推出時數，早於或等於開始視為隔天", () => {
    expect(minutesUntil("2026-10-07T20:00", "21:30")).toBe(90);
    expect(minutesUntil("2026-10-07T23:00", "00:30")).toBe(90);
    expect(minutesUntil("2026-10-07T20:00", "20:00")).toBe(1440);
    expect(minutesUntil("2026-10-07T20:00", "")).toBeNull();
  });

  it("時數文字只接受正數，並保留非 0.5 倍數讓畫面提示", () => {
    expect(parseHours("1.5")).toBe(90);
    expect(parseHours("0.33")).toBe(20);
    expect(parseHours("")).toBeNull();
    expect(parseHours("0")).toBeNull();
    expect(parseHours("abc")).toBeNull();
    expect(hoursText(30)).toBe("0.5");
    expect(hoursText(60)).toBe("1");
    expect(hoursText(20)).toBe("0.33");
  });

  it("只有 0.5 小時的倍數才能送出", () => {
    expect(isValidOvertimeMinutes(30)).toBe(true);
    expect(isValidOvertimeMinutes(1440)).toBe(true);
    expect(isValidOvertimeMinutes(20)).toBe(false);
    expect(isValidOvertimeMinutes(1470)).toBe(false);
    expect(isValidOvertimeMinutes(null)).toBe(false);
  });
});

describe("多日加班的月份與小計", () => {
  it("月份範圍的結束是下個月月初", () => {
    expect(monthRange("2026-10")).toEqual({ startsOn: "2026-10-01", endsOn: "2026-11-01" });
    expect(monthRange("2026-12")).toEqual({ startsOn: "2026-12-01", endsOn: "2027-01-01" });
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("")).toBeNull();
    expect(nextDate("2026-02-28")).toBe("2026-03-01");
  });

  it("依時數分組列出天數與總時數", () => {
    expect(summarizeAssignments({ "2026-10-01": 30, "2026-10-02": 60, "2026-10-03": 30 })).toEqual({ days: 3, totalMinutes: 120, breakdown: "0.5 小時 × 2 天、1 小時 × 1 天" });
    expect(summarizeAssignments({})).toEqual({ days: 0, totalMinutes: 0, breakdown: "" });
  });
});
