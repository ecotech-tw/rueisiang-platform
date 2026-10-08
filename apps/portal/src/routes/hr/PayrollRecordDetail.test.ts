import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { payrollLineLabel, payrollWorkerWorkDays, PayrollWorkerWorkSummary, specialWorkdayDifferenceLabel } from "./PayrollRecordDetail.js";
import type { PayrollScheduleAllocationDetail, PayrollWorker } from "./api.js";

function allocationDetail(patch: Partial<PayrollScheduleAllocationDetail> = {}): PayrollScheduleAllocationDetail {
  return {
    date: "2026-09-03",
    shiftGroupId: null,
    scopeId: "scope",
    shiftVersionId: "shift",
    requiredHeadcount: 1,
    assignedCount: 1,
    effectiveCount: 1,
    attendanceStatus: "present",
    allocatedUnits: 1,
    unitNumerator: 1,
    unitDenominator: 1,
    ...patch,
  };
}

describe("薪資明細項目文案", () => {
  it("業績獎金使用獎金設定名稱，讓多筆獎金可以區分", () => {
    const line = (lineKey: string, policyName: string) => ({
      lineKey,
      direction: "earning" as const,
      amountMinor: 1,
      explanation: { policyName },
    }) as Parameters<typeof payrollLineLabel>[0];

    expect([line("bonus_1", "西門櫃點獎金"), line("bonus_2", "個人業績獎金")].map(payrollLineLabel)).toEqual(["西門櫃點獎金", "個人業績獎金"]);
  });

  it("沒有獎金設定名稱的歷史明細保留通用文案", () => {
    const line = {
      lineKey: "bonus_1",
      direction: "earning" as const,
      amountMinor: 1,
      explanation: {},
    } as Parameters<typeof payrollLineLabel>[0];

    expect(payrollLineLabel(line)).toBe("業績獎金");
  });
});

describe("支援人員逐日計薪依據", () => {
  it("依日期合併排班工時與分配後計薪工時", () => {
    expect(payrollWorkerWorkDays([
      allocationDetail({ scheduledHours: 8, payableHours: 4 }),
      allocationDetail({ shiftGroupId: "second", scheduledHours: 2, payableHours: 1, allocatedUnits: 0.5, unitNumerator: 1, unitDenominator: 2 }),
      allocationDetail({ date: "2026-09-04", scheduledHours: 6, payableHours: 6 }),
    ])).toEqual([
      { date: "2026-09-03", allocatedUnits: 1.5, payBasis: null, scheduledHours: 10, payableHours: 5 },
      { date: "2026-09-04", allocatedUnits: 1, payBasis: null, scheduledHours: 6, payableHours: 6 },
    ]);
  });

  it("日薪明列計薪日期，時薪明列每日排班與分配工時", () => {
    const details = [allocationDetail({ scheduledHours: 8, payableHours: 4 })];
    const daily = renderToStaticMarkup(createElement(PayrollWorkerWorkSummary, { worker: { payBasis: "daily" } as PayrollWorker, details }));
    const hourly = renderToStaticMarkup(createElement(PayrollWorkerWorkSummary, { worker: { payBasis: "hourly" } as PayrollWorker, details }));

    expect(daily).toContain("日薪計薪日期");
    expect(daily).toContain("2026-09-03");
    expect(hourly).toContain("時薪逐日工時");
    expect(hourly).toContain("排班 8 小時・計薪 4 小時");
  });

  it("舊試算沒有逐日工時時明確標示，不回推猜測", () => {
    const html = renderToStaticMarkup(createElement(PayrollWorkerWorkSummary, { worker: { payBasis: "hourly" } as PayrollWorker, details: [allocationDetail()] }));

    expect(html).toContain("工時未保存");
    expect(html).toContain("無法回溯工時數");
  });

  it("同月份敘薪方式變更時按日期列出日薪或時薪依據", () => {
    const html = renderToStaticMarkup(createElement(PayrollWorkerWorkSummary, {
      worker: { payBasis: "mixed" } as PayrollWorker,
      details: [
        allocationDetail({ date: "2026-09-03", payBasis: "daily", scheduledHours: 8, payableHours: 8 }),
        allocationDetail({ date: "2026-09-04", payBasis: "hourly", scheduledHours: 6, payableHours: 3 }),
      ],
    }));

    expect(html).toContain("2026-09-03");
    expect(html).toContain("納入日薪計算");
    expect(html).toContain("2026-09-04");
    expect(html).toContain("時薪・排班 6 小時・計薪 3 小時");
  });
});

describe("特殊上班日薪資差額文案", () => {
  it("正向差額顯示薪資加給，負向差額顯示薪資扣回", () => {
    const line = (direction: "earning" | "deduction") => ({
      lineKey: "special_workday",
      direction,
      amountMinor: 1,
      explanation: { ruleNames: ["夜間進／撤櫃"] },
    }) as Parameters<typeof specialWorkdayDifferenceLabel>[0];

    expect(specialWorkdayDifferenceLabel(line("earning"))).toBe("夜間進／撤櫃：薪資加給");
    expect(specialWorkdayDifferenceLabel(line("deduction"))).toBe("夜間進／撤櫃：薪資扣回");
  });
});
