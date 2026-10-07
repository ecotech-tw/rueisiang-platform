import { describe, expect, it } from "vitest";
import { visiblePayrollJobs } from "./PayrollSettlement.js";

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

// D1 的 CURRENT_TIMESTAMP 是沒有時區標記的 UTC。
const now = Date.parse("2026-10-07T02:00:00Z");
const visibleIds = (jobs: Job[]) => visiblePayrollJobs(jobs, now).map((item) => item.jobId);

describe("薪資試算面板要列哪些工作", () => {
  it("進行中的工作一律顯示", () => {
    expect(visibleIds([job({ jobId: "queued", status: "queued" }), job({ jobId: "calculating", status: "calculating" })])).toEqual(["queued", "calculating"]);
  });

  it("剛算完的顯示，歷史上算完的不顯示", () => {
    expect(visibleIds([job({ jobId: "recent", completedAt: "2026-10-07 01:55:00" }), job({ jobId: "old", completedAt: "2026-10-07 01:40:00" })])).toEqual(["recent"]);
  });

  it("失敗的工作留著，直到同月份之後有試算成功", () => {
    const failed = job({ jobId: "failed", status: "failed", updatedAt: "2026-10-06 03:00:00" });
    expect(visibleIds([failed])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "other-month", periodKey: "2026-09", completedAt: "2026-10-06 04:00:00" })])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "earlier", completedAt: "2026-10-06 02:00:00" })])).toEqual(["failed"]);
    expect(visibleIds([failed, job({ jobId: "later", completedAt: "2026-10-06 04:00:00" })])).toEqual([]);
  });
});
