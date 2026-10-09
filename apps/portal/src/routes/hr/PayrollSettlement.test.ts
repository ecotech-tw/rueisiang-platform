import { describe, expect, it } from "vitest";
import { availablePayrollEmployees, availablePayrollWorkers, visiblePayrollJobs } from "./PayrollSettlement.js";

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
    expect(availablePayrollEmployees([{ userId: "calculated" }, { userId: "available" }], exclusions)).toEqual([{ userId: "available" }]);
    expect(availablePayrollWorkers([{ id: "worker-calculated" }, { id: "worker-available" }], exclusions)).toEqual([{ id: "worker-available" }]);
  });

  it("名單載入失敗或當月全體都已被占用時不提供可選人員", () => {
    const exclusions = { employeeUserIds: [], workerIds: [], allEmployees: true, allWorkers: true };
    expect(availablePayrollEmployees([{ userId: "employee" }], undefined)).toEqual([]);
    expect(availablePayrollEmployees([{ userId: "employee" }], exclusions)).toEqual([]);
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
