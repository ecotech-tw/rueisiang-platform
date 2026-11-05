import { describe, expect, it } from "vitest";
import { availablePayrollEmployees, availablePayrollWorkers, payrollEmployeesInPeriod, visiblePayrollJobs } from "./PayrollSettlement.js";

type Job = Parameters<typeof visiblePayrollJobs>[0][number];

function job(patch: Partial<Job>): Job {
  return {
    jobId: "job",
    runId: null,
    requestId: "request",
    runName: "十月薪資",
    periodKey: "2026-10",
    payDate: null,
    status: "ready",
    phase: "completed",
    expectedCount: 1,
    completedCount: 1,
    progressPercent: 100,
    error: null,
    dispatchPending: false,
    createdAt: "2026-10-07 01:00:00",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-07 01:00:00",
    ...patch,
  };
}

const visibleIds = (jobs: Job[]) => visiblePayrollJobs(jobs).map((item) => item.jobId);

describe("新增薪資試算的可選人員", () => {
  it("排除本月已有試算結果或正在試算的人員", () => {
    const exclusions = { employeeUserIds: ["calculated"], workerIds: ["worker-calculated"], allEmployees: false, allWorkers: false };
    expect(availablePayrollEmployees([{ userId: "calculated", serviceStartOn: "2026-01-01" }, { userId: "available", serviceStartOn: "2026-01-01" }], exclusions, "2026-10")).toEqual([{ userId: "available", serviceStartOn: "2026-01-01" }]);
    expect(availablePayrollWorkers([{ id: "worker-calculated" }, { id: "worker-available" }], exclusions)).toEqual([{ id: "worker-available" }]);
  });

  it("依薪資月份排除尚未到職或未設定服務起算日的正式員工，且明確區分日期資格與試算排除", () => {
    const exclusions = { employeeUserIds: ["october"], workerIds: [], allEmployees: false, allWorkers: false };
    const employees = [
      { userId: "october", serviceStartOn: "2026-10-31" },
      { userId: "november", serviceStartOn: "2026-11-01" },
      { userId: "missing", serviceStartOn: null },
    ];
    expect(payrollEmployeesInPeriod(employees, "2026-10").map((employee) => employee.userId)).toEqual(["october"]);
    expect(availablePayrollEmployees(employees, exclusions, "2026-10")).toEqual([]);
  });

  it("名單載入失敗或當月全體都已被占用時不提供可選人員", () => {
    const exclusions = { employeeUserIds: [], workerIds: [], allEmployees: true, allWorkers: true };
    expect(availablePayrollEmployees([{ userId: "employee", serviceStartOn: "2026-01-01" }], undefined, "2026-10")).toEqual([]);
    expect(availablePayrollEmployees([{ userId: "employee", serviceStartOn: "2026-01-01" }], exclusions, "2026-10")).toEqual([]);
    expect(availablePayrollWorkers([{ id: "worker" }], exclusions)).toEqual([]);
  });
});

describe("薪資試算面板要列哪些工作", () => {
  it("進行中的工作一律顯示", () => {
    expect(visibleIds([job({ jobId: "queued", status: "queued" }), job({ jobId: "calculating", status: "calculating" })])).toEqual(["queued", "calculating"]);
  });

  it("算完的不顯示，剛算完的也一樣", () => {
    expect(visibleIds([job({ jobId: "recent", completedAt: "2026-10-07 01:59:59" }), job({ jobId: "old", completedAt: "2026-10-07 01:40:00" })])).toEqual([]);
  });

  it("失敗的工作留著，直到同月份之後有試算成功", () => {
    const failed = job({ jobId: "failed", status: "failed", updatedAt: "2026-10-06 03:00:00" });
    expect(visibleIds([failed])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "other-month", periodKey: "2026-09", completedAt: "2026-10-06 04:00:00" })])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "earlier", completedAt: "2026-10-06 02:00:00" })])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "later", completedAt: "2026-10-06 04:00:00" })])).toEqual([]);
  });
});
