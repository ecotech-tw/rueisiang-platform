import {
  beginHrPayrollJob,
  calculateHrPayroll,
  completeHrPayrollJob,
  createDatabase,
  failHrPayrollJob,
  getHrPayrollJobInput,
  getHrPayrollJobRecord,
  reportHrPayrollJobProgress,
  retryHrPayrollJobLater,
  HrError,
} from "@rueisiang/db";
import type { Env } from "./env.js";
import { isPayrollQueueMessage } from "./payroll-queue.js";

const PAYROLL_RUN_MAX_ATTEMPTS = 3;

/**
 * 每個背景薪資工作一個 DO；DO 只保存 job id 與 alarm cursor，薪資結果仍由 D1 保存。
 * 這樣 Queue 重複投遞時會回到同一個序列，不會同時啟動兩份試算。
 */
export class PayrollRunAgent {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/start") {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json().catch(() => null) as unknown;
    if (!isPayrollQueueMessage(body)) return new Response("Invalid payroll queue message", { status: 400 });
    const currentJobId = await this.state.storage.get<string>("jobId");
    if (currentJobId && currentJobId !== body.jobId) return new Response("Payroll DO job mismatch", { status: 409 });
    const db = createDatabase(this.env.DB);
    // 在回覆 Queue 前先由 D1 原子 claim：terminal Queue failure 只能處理
    // 尚未被 DO 接手的工作，不能覆蓋已排入 alarm 的計算。
    // 若退避 alarm 已存在，重複 Queue 投遞不可提前消耗下一次 attempt。
    const job = await this.state.storage.getAlarm() === null
      ? await beginHrPayrollJob(db, body.jobId)
      : await getHrPayrollJobRecord(db, body.jobId);
    if (job.status === "ready" || job.status === "failed") {
      return new Response(JSON.stringify({ accepted: true, jobId: body.jobId }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    await this.state.storage.put("jobId", body.jobId);
    // Queue 重複投遞只需要確保有 alarm；不要把既有的退避時間重設成現在，
    // 否則暫時性 D1／外部錯誤會因 duplicate message 變成忙迴圈。
    if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(Date.now());
    return new Response(JSON.stringify({ accepted: true, jobId: body.jobId }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async alarm(): Promise<void> {
    const jobId = await this.state.storage.get<string>("jobId");
    if (!jobId) return;

    const db = createDatabase(this.env.DB);
    let current: Awaited<ReturnType<typeof getHrPayrollJobRecord>>;
    try {
      current = await getHrPayrollJobRecord(db, jobId);
    } catch (error) {
      // 工作被清理後，舊 alarm 沒有任何可重試的對象；其他 D1 錯誤仍交給 alarm retry。
      if (error instanceof HrError && error.status === 404) return;
      throw error;
    }
    if (current.status === "ready" || current.status === "failed") return;
    // The Queue fetch claims the initial attempt. A retry alarm moves the job
    // back to queued, so only that path needs another atomic begin here.
    const job = current.status === "calculating" ? current : await beginHrPayrollJob(db, jobId);
    if (job.status === "ready" || job.status === "failed") return;

    try {
      const result = await calculateHrPayroll(
        db,
        getHrPayrollJobInput(job),
        { id: job.actorId, email: job.actorEmail },
        { onProgress: (progress) => reportHrPayrollJobProgress(db, jobId, progress, job.attemptCount) },
      );
      await completeHrPayrollJob(db, jobId, result.runId, result.employees.length + result.workers.length, job.attemptCount);
    } catch (error) {
      if (error instanceof HrError) {
        await failHrPayrollJob(db, jobId, error.message, job.attemptCount);
        return;
      }

      console.error("薪資背景工作執行失敗", error);
      if (job.attemptCount >= PAYROLL_RUN_MAX_ATTEMPTS) {
        await failHrPayrollJob(db, jobId, "薪資背景工作自動重試次數已用盡，請按「重新試算」。 ", job.attemptCount);
        return;
      }
      await retryHrPayrollJobLater(db, jobId, "薪資背景工作暫時失敗，系統將自動重試。 ", job.attemptCount);
      await this.state.storage.setAlarm(Date.now() + Math.min(60_000, 2 ** Math.max(0, job.attemptCount - 1) * 1_000));
    }
  }
}
