import { describe, expect, it } from "vitest";
import { pageDirection, swipeTarget } from "./page-direction.js";

const sections = ["/forms", "/payroll", "/clock", "/notifications", "/profile"];

describe("pageDirection", () => {
  it("選單往右走是 forward，往左走是 back", () => {
    expect(pageDirection(sections, "/forms", "/notifications")).toBe("forward");
    expect(pageDirection(sections, "/notifications", "/forms")).toBe("back");
  });

  it("跨區落在區首頁時看選單位置，不看來源的深度", () => {
    expect(pageDirection(sections, "/payroll/run/emp", "/profile")).toBe("forward");
    expect(pageDirection(sections, "/forms/leave", "/clock")).toBe("forward");
    expect(pageDirection(sections, "/payroll/run/emp", "/forms")).toBe("back");
  });

  it("跨區點進深一層的頁面一律是 forward", () => {
    expect(pageDirection(sections, "/clock/calendar", "/forms/new")).toBe("forward");
    expect(pageDirection(sections, "/clock/calendar", "/forms/leave")).toBe("forward");
  });

  it("同一區往深處是 forward，回上層是 back", () => {
    expect(pageDirection(sections, "/forms", "/forms/leave")).toBe("forward");
    expect(pageDirection(sections, "/forms/leave", "/forms")).toBe("back");
    expect(pageDirection(sections, "/payroll/run/emp", "/payroll")).toBe("back");
  });

  it("同一頁或同層換頁判斷不出方向", () => {
    expect(pageDirection(sections, "/forms", "/forms")).toBeNull();
    expect(pageDirection(sections, "/forms/leave", "/forms/overtime")).toBeNull();
  });

  it("名稱只是前綴相同的路徑不算同一區", () => {
    expect(pageDirection(["/forms", "/formsx"], "/forms", "/formsx")).toBe("forward");
  });
});

describe("swipeTarget", () => {
  const tabs = ["leave", "overtime", "clock_correction"] as const;

  it("左滑往下一個，右滑往上一個", () => {
    expect(swipeTarget(tabs, "overtime", -80)).toBe("clock_correction");
    expect(swipeTarget(tabs, "overtime", 80)).toBe("leave");
  });

  it("到頭就停住，不繞回另一端", () => {
    expect(swipeTarget(tabs, "leave", 80)).toBeNull();
    expect(swipeTarget(tabs, "clock_correction", -80)).toBeNull();
  });
});
