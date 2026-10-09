import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OvertimeDayPicker } from "./OvertimeDayPicker.js";
import { addMinutes, buildOvertimeEntries, buildOvertimeSubmission, hoursText, isValidOvertimeMinutes, minutesUntil, monthRange, nextDate, parseHours, selectedUnscheduledDates, summarizeAssignments } from "./overtime-entry.js";

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

describe("加班申請的對象與送出內容", () => {
  it("單日支援人員加班送 workerId，不會誤送成正式員工", () => {
    expect(buildOvertimeSubmission({
      targetKind: "worker", employeeUserId: "", workerId: "worker-1", mode: "single",
      requestedStart: "2026-10-07T23:00", requestedEnd: "2026-10-08T00:30",
      settlementKind: "pay", reason: "跨午夜支援加班", entries: [],
    })).toEqual({
      path: "/requests/overtime", method: "POST",
      values: { workerId: "worker-1", settlementKind: "pay", reason: "跨午夜支援加班", requestedStart: "2026-10-07T23:00", requestedEnd: "2026-10-08T00:30" },
    });
  });

  it("多日正式員工加班維持 employeeUserId 與批次路徑", () => {
    expect(buildOvertimeSubmission({
      targetKind: "employee", employeeUserId: "user-1", workerId: "", mode: "multiple",
      requestedStart: "", requestedEnd: "", settlementKind: "compensatory", reason: "多日補休",
      entries: [{ requestedStart: "2026-10-01T18:00", requestedEnd: "2026-10-01T19:00" }],
    })).toEqual({
      path: "/requests/overtime/batch", method: "POST",
      values: { employeeUserId: "user-1", settlementKind: "compensatory", reason: "多日補休", entries: [{ requestedStart: "2026-10-01T18:00", requestedEnd: "2026-10-01T19:00" }] },
    });
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

  it("未排班日期必須指定起始時間；有排班日期仍沿用班表下班時間", () => {
    const days = [
      { date: "2026-10-13", startAt: null },
      { date: "2026-10-14", startAt: "2026-10-14T20:00" },
    ];
    const assigned = { "2026-10-13": 90, "2026-10-14": 60 };

    expect(selectedUnscheduledDates(days, assigned)).toEqual(["2026-10-13"]);
    expect(buildOvertimeEntries(days, assigned, "")).toEqual([
      { requestedStart: "2026-10-14T20:00", requestedEnd: "2026-10-14T21:00" },
    ]);
    expect(buildOvertimeEntries(days, assigned, "18:30")).toEqual([
      { requestedStart: "2026-10-13T18:30", requestedEnd: "2026-10-13T20:00" },
      { requestedStart: "2026-10-14T20:00", requestedEnd: "2026-10-14T21:00" },
    ]);
    expect(buildOvertimeEntries(days, assigned, "25:00")).toHaveLength(1);
  });

  it("未排班日期可點選，選取後仍標示未排班狀態", () => {
    const days = [{ date: "2026-10-13", startAt: null, hasExisting: false }];
    const unselected = renderToStaticMarkup(createElement(OvertimeDayPicker, { days, assigned: {}, onToggle: () => {} }));
    expect(unselected).toContain('class="hr-overtime-day unscheduled"');
    expect(unselected).not.toContain("disabled");
    expect(unselected).toContain("未排班");

    const selected = renderToStaticMarkup(createElement(OvertimeDayPicker, { days, assigned: { "2026-10-13": 60 }, onToggle: () => {} }));
    expect(selected).toContain('class="hr-overtime-day selected unscheduled"');
    expect(selected).toContain('class="hr-overtime-day-status">未排班</small>');
  });

  it("依時數分組列出天數與總時數", () => {
    expect(summarizeAssignments({ "2026-10-01": 30, "2026-10-02": 60, "2026-10-03": 30 })).toEqual({ days: 3, totalMinutes: 120, breakdown: "0.5 小時 × 2 天、1 小時 × 1 天" });
    expect(summarizeAssignments({})).toEqual({ days: 0, totalMinutes: 0, breakdown: "" });
  });
});
