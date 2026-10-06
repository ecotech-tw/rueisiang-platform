import {
  createDatabase,
  failHrPayrollJob,
  getHrPayrollJobRecord,
  listPendingHrPayrollJobs,
  markHrPayrollJobDispatchFailed,
  markHrPayrollJobEnqueued,
  type Database,
} from "@rueisiang/db";
import type { Env } from "./env.js";

export interface PayrollQueueMessage {
  kind: "payroll";
  jobId: string;
}

/** Cloudflare 的 max_retries 不包含第一次投遞；attempts 會從 1 開始。 */
export const PAYROLL_QUEUE_MAX_RETRIES = 3;
export const PAYROLL_QUEUE_MAX_ATTEMPTS = PAYROLL_QUEUE_MAX_RETRIES + 1;

export function isPayrollQueueMessage(value: unknown): value is PayrollQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.kind === "payroll" && typeof message.jobId === "string" && message.jobId.trim().length > 0;
}

export async function enqueuePayrollJob(env: Env, db: Database, jobId: string): Promise<void> {
  if (!env.PAYROLL_QUEUE) throw new Error("薪資背景工作 Queue 尚未設定。 ");
  try {
    await env.PAYROLL_QUEUE.send({ kind: "payroll", jobId });
    await markHrPayrollJobEnqueued(db, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Queue 投遞失敗。";
    await markHrPayrollJobDispatchFailed(db, jobId, message);
  }
}

export async function drainPayrollQueueOutbox(db: Database, env: Env): Promise<void> {
  if (!env.PAYROLL_QUEUE) return;
  const jobs = await listPendingHrPayrollJobs(db, 20);
  for (const job of jobs) await enqueuePayrollJob(env, db, job.id);
}

export async function processPayrollQueueMessage(message: PayrollQueueMessage, env: Env): Promise<void> {
  if (!env.PAYROLL_RUN_AGENT) throw new Error("薪資背景工作 Durable Object 尚未設定。 ");
  const response = await env.PAYROLL_RUN_AGENT.getByName(message.jobId).fetch(new Request("https://payroll-run/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  }));
  if (!response.ok) throw new Error(`薪資背景工作啟動失敗（${response.status}）。`);
}

export async function failPayrollQueueMessage(message: PayrollQueueMessage, env: Env, error: unknown): Promise<void> {
  const db = createDatabase(env.DB);
  const job = await getHrPayrollJobRecord(db, message.jobId);
  // DO 已經接手後，Queue 的重複訊息不可以把正在計算的新嘗試標成失敗。
  if (job.status !== "queued") return;
  const details = error instanceof Error ? error.message : "背景佇列投遞失敗。";
  await failHrPayrollJob(db, message.jobId, `背景工作佇列重試 ${PAYROLL_QUEUE_MAX_RETRIES} 次後仍失敗：${details}`);
}
