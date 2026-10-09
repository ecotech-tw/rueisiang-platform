import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, type HrActor } from "./hr-people.js";
import { assertHrPayrollSelectionAvailable, HR_PAYROLL_CALCULATION_INPUT_JSON_MAX_LENGTH, type HrPayrollCalculationInput } from "./hr-payroll-calculation.js";
import { hrPayrollJobs, type HrPayrollJob } from "./schema/hr-payroll-runs.js";

export type HrPayrollJobStatus = HrPayrollJob["status"];
export type HrPayrollJobPhase = HrPayrollJob["phase"];
/** Queue producer 連續失敗時停止 cron 無限重送，讓管理者可以人工重新試算。 */
export const HR_PAYROLL_MAX_QUEUE_DISPATCH_ATTEMPTS = 3;

export interface HrPayrollJobView {
  jobId: string;
  runId: string | null;
  requestId: string;
  runName: string;
  periodKey: string;
  payDate: string | null;
  status: HrPayrollJobStatus;
  phase: HrPayrollJobPhase;
  expectedCount: number;
  completedCount: number;
  progressPercent: number | null;
  error: string | null;
  dispatchPending: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface CreateHrPayrollJobInput {
  calculation: HrPayrollCalculationInput;
  expectedCount?: number;
}

function parseInput(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function runNameFromInput(input: Record<string, unknown>, periodKey: string): string {
  return typeof input.runName === "string" && input.runName.trim() ? input.runName.trim() : `${periodKey}薪資`;
}

function toView(row: HrPayrollJob): HrPayrollJobView {
  const input = parseInput(row.calculationInputJson);
  const progressPercent = row.status === "ready"
    ? 100
    : row.expectedCount > 0
      ? Math.min(100, Math.floor(row.completedCount / row.expectedCount * 100))
      : null;
  return {
    jobId: row.id,
    runId: row.payrollRunId,
    requestId: row.requestId,
    runName: runNameFromInput(input, typeof input.periodKey === "string" ? input.periodKey : ""),
    periodKey: typeof input.periodKey === "string" ? input.periodKey : "",
    payDate: typeof input.payDate === "string" ? input.payDate : null,
    status: row.status,
    phase: row.phase,
    expectedCount: row.expectedCount,
    completedCount: row.completedCount,
    progressPercent,
    error: row.lastError || row.queueError || null,
    // 完成／失敗是 terminal state；即使 Queue 投遞成功後 D1 回寫曾逾時，
    // 也不能讓畫面把已結束的工作誤顯示成仍在等待派送。
    dispatchPending: row.status === "queued" && row.queueStatus === "pending",
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

export async function getHrPayrollJobRecord(db: Database, jobId: string): Promise<HrPayrollJob> {
  const [row] = await db.select().from(hrPayrollJobs).where(eq(hrPayrollJobs.id, jobId)).limit(1);
  if (!row) throw new HrError(404, "找不到薪資背景工作。 ");
  return row;
}

export function getHrPayrollJobInput(row: HrPayrollJob): HrPayrollCalculationInput {
  const input = parseInput(row.calculationInputJson) as unknown as HrPayrollCalculationInput;
  if (!input.periodKey || !input.requestId) throw new HrError(409, "薪資背景工作的輸入快照無法解析，請重新試算。 ");
  return input;
}

export async function getHrPayrollJob(db: Database, jobId: string): Promise<HrPayrollJobView> {
  return toView(await getHrPayrollJobRecord(db, jobId));
}

export async function listHrPayrollJobs(db: Database, limit = 10): Promise<HrPayrollJobView[]> {
  const rows = await db.select().from(hrPayrollJobs)
    .orderBy(desc(hrPayrollJobs.updatedAt), desc(hrPayrollJobs.createdAt))
    .limit(Math.max(1, Math.min(50, limit)));
  return rows.map(toView);
}

export async function listPendingHrPayrollJobs(db: Database, limit = 20): Promise<HrPayrollJob[]> {
  return db.select().from(hrPayrollJobs)
    .where(and(eq(hrPayrollJobs.status, "queued"), eq(hrPayrollJobs.queueStatus, "pending")))
    .orderBy(hrPayrollJobs.createdAt)
    .limit(Math.max(1, Math.min(50, limit)));
}

export async function createHrPayrollJob(db: Database, input: CreateHrPayrollJobInput, actor: HrActor): Promise<{ job: HrPayrollJobView; created: boolean }> {
  const requestId = input.calculation.requestId ?? crypto.randomUUID();
  const calculation = { ...input.calculation, requestId } satisfies HrPayrollCalculationInput;
  const expectedCount = input.expectedCount ?? 0;
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || expectedCount > 1000) throw new HrError(400, "薪資背景工作的預估人數不正確。 ");

  const [existing] = await db.select().from(hrPayrollJobs).where(eq(hrPayrollJobs.requestId, requestId)).limit(1);
  if (existing) return { job: toView(existing), created: false };
  await assertHrPayrollSelectionAvailable(db, calculation);

  const jobId = crypto.randomUUID();
  const calculationInputJson = JSON.stringify(calculation);
  if (calculationInputJson.length > HR_PAYROLL_CALCULATION_INPUT_JSON_MAX_LENGTH) throw new HrError(400, "薪資背景工作的輸入資料過大，請縮小試算人員範圍後再試。 ");
  try {
    await db.insert(hrPayrollJobs).values({
      id: jobId,
      requestId,
      calculationInputJson,
      actorId: actor.id,
      actorEmail: actor.email,
      expectedCount,
      completedCount: 0,
      status: "queued",
      phase: "queued",
      queueStatus: "pending",
      queueAttempts: 0,
      queueError: "",
      lastError: "",
    });
  } catch (error) {
    if (!(error instanceof Error && /UNIQUE constraint failed/.test(error.message))) throw error;
    const [raced] = await db.select().from(hrPayrollJobs).where(eq(hrPayrollJobs.requestId, requestId)).limit(1);
    if (!raced) throw error;
    return { job: toView(raced), created: false };
  }
  return { job: await getHrPayrollJob(db, jobId), created: true };
}

export async function retryHrPayrollJob(db: Database, jobId: string, actor: HrActor): Promise<{ job: HrPayrollJobView; created: boolean }> {
  const failed = await getHrPayrollJobRecord(db, jobId);
  if (failed.status !== "failed") throw new HrError(409, "只有失敗的薪資背景工作可以重新試算。 ");
  // 沿用同一個 requestId 與 job id：如果失敗發生在薪資結果已寫入、但 job 尚未標記 ready 的窗口，
  // 重新建立另一筆工作會繞過 requestId 去重，產生第二個同月份的未結算批次。
  getHrPayrollJobInput(failed);
  await db.update(hrPayrollJobs).set({
    payrollRunId: null,
    actorId: actor.id,
    actorEmail: actor.email,
    status: "queued",
    phase: "queued",
    completedCount: 0,
    attemptCount: 0,
    queueStatus: "pending",
    queueAttempts: 0,
    queueError: "",
    lastError: "",
    startedAt: null,
    completedAt: null,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(eq(hrPayrollJobs.id, jobId), eq(hrPayrollJobs.status, "failed")));
  return { job: await getHrPayrollJob(db, jobId), created: false };
}

export async function markHrPayrollJobEnqueued(db: Database, jobId: string): Promise<void> {
  const job = await getHrPayrollJobRecord(db, jobId);
  if (job.queueStatus === "enqueued" || job.status === "ready" || job.status === "failed") return;
  await db.update(hrPayrollJobs).set({
    queueStatus: "enqueued",
    queueAttempts: sql`${hrPayrollJobs.queueAttempts} + 1`,
    queueError: "",
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    sql`${hrPayrollJobs.status} IN ('queued', 'calculating')`,
    eq(hrPayrollJobs.queueStatus, "pending"),
  ));
}

export async function markHrPayrollJobDispatchFailed(db: Database, jobId: string, message: string): Promise<void> {
  const job = await getHrPayrollJobRecord(db, jobId);
  if (job.status !== "queued" || job.queueStatus === "enqueued") return;
  const nextQueueAttempts = job.queueAttempts + 1;
  const exhausted = nextQueueAttempts >= HR_PAYROLL_MAX_QUEUE_DISPATCH_ATTEMPTS;
  const dispatchError = message.slice(0, 2000);
  await db.update(hrPayrollJobs).set({
    status: exhausted ? "failed" : "queued",
    phase: exhausted ? "failed" : "queued",
    queueStatus: "pending",
    queueAttempts: sql`${hrPayrollJobs.queueAttempts} + 1`,
    queueError: dispatchError,
    lastError: exhausted ? `薪資背景工作 Queue 派送失敗 ${nextQueueAttempts} 次，請按「重新試算」。 ${dispatchError}`.slice(0, 2000) : "",
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    eq(hrPayrollJobs.status, "queued"),
    eq(hrPayrollJobs.queueStatus, "pending"),
  ));
}

export async function beginHrPayrollJob(db: Database, jobId: string): Promise<HrPayrollJob> {
  const job = await getHrPayrollJobRecord(db, jobId);
  if (job.status === "ready" || job.status === "failed" || job.status === "calculating") return job;
  const next = {
    status: "calculating" as const,
    phase: "preparing" as const,
    attemptCount: job.attemptCount + 1,
    startedAt: job.startedAt ?? new Date().toISOString(),
    lastError: "",
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
  await db.update(hrPayrollJobs).set(next).where(and(eq(hrPayrollJobs.id, jobId), eq(hrPayrollJobs.status, "queued")));
  return getHrPayrollJobRecord(db, jobId);
}

export async function reportHrPayrollJobProgress(db: Database, jobId: string, progress: { phase: Exclude<HrPayrollJobPhase, "queued" | "completed" | "failed">; expectedCount: number; completedCount: number }, expectedAttemptCount?: number): Promise<void> {
  await db.update(hrPayrollJobs).set({
    status: "calculating",
    phase: progress.phase,
    expectedCount: Math.max(0, progress.expectedCount),
    completedCount: Math.min(Math.max(0, progress.completedCount), Math.max(0, progress.expectedCount)),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    eq(hrPayrollJobs.status, "calculating"),
    expectedAttemptCount === undefined ? undefined : eq(hrPayrollJobs.attemptCount, expectedAttemptCount),
  ));
}

export async function completeHrPayrollJob(db: Database, jobId: string, runId: string, resultCount: number, expectedAttemptCount?: number): Promise<void> {
  await db.update(hrPayrollJobs).set({
    payrollRunId: runId,
    status: "ready",
    phase: "completed",
    queueStatus: "enqueued",
    queueError: "",
    expectedCount: resultCount,
    completedCount: resultCount,
    lastError: "",
    completedAt: sql`CURRENT_TIMESTAMP`,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    eq(hrPayrollJobs.status, "calculating"),
    expectedAttemptCount === undefined ? undefined : eq(hrPayrollJobs.attemptCount, expectedAttemptCount),
  ));
}

export async function failHrPayrollJob(db: Database, jobId: string, message: string, expectedAttemptCount?: number): Promise<void> {
  await db.update(hrPayrollJobs).set({
    status: "failed",
    phase: "failed",
    queueStatus: "enqueued",
    lastError: message.slice(0, 2000),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    sql`${hrPayrollJobs.status} <> 'ready'`,
    expectedAttemptCount === undefined ? undefined : eq(hrPayrollJobs.attemptCount, expectedAttemptCount),
  ));
}

/**
 * Queue terminal failure may only fail a job that the DO has never claimed.
 * The status and attempt guard must be in the same UPDATE as the transition:
 * a duplicate Queue delivery can race the DO alarm between its read and write.
 */
export async function failHrPayrollQueueJob(db: Database, jobId: string, message: string): Promise<void> {
  await db.update(hrPayrollJobs).set({
    status: "failed",
    phase: "failed",
    queueStatus: "enqueued",
    lastError: message.slice(0, 2000),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    eq(hrPayrollJobs.status, "queued"),
    eq(hrPayrollJobs.attemptCount, 0),
  ));
}

export async function retryHrPayrollJobLater(db: Database, jobId: string, message: string, expectedAttemptCount?: number): Promise<void> {
  await db.update(hrPayrollJobs).set({
    status: "queued",
    phase: "preparing",
    lastError: message.slice(0, 2000),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrPayrollJobs.id, jobId),
    eq(hrPayrollJobs.status, "calculating"),
    expectedAttemptCount === undefined ? undefined : eq(hrPayrollJobs.attemptCount, expectedAttemptCount),
  ));
}
