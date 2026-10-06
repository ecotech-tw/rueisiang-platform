import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import app, { queue } from "./index.js";
import { PayrollRunAgent } from "./payroll-run-do.js";
import type { PayrollQueueMessage } from "./payroll-queue.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { seedDevData } from "./dev/fixtures.js";

const SECRET = "hr-payroll-async-test-secret";
let d1: LocalD1;
let cookie: string;
let queueMessages: PayrollQueueMessage[];
let queueFailure: Error | null;

function testEnv() {
  return {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "test",
    GOOGLE_OAUTH_CLIENT_SECRET: "test",
    PAYROLL_QUEUE: { send: async (message: PayrollQueueMessage) => { if (queueFailure) throw queueFailure; queueMessages.push(message); } },
    PAYROLL_RUN_AGENT: {} as DurableObjectNamespace,
  } as never;
}

async function request(path: string, method = "GET", payload?: unknown) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), testEnv());
}

function doState() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      setAlarm: async (at: number) => { alarmAt = at; },
      deleteAlarm: async () => { alarmAt = null; },
      getAlarm: async () => alarmAt,
    },
    blockConcurrencyWhile: async (initialize: () => Promise<void>) => initialize(),
  } as unknown as DurableObjectState;
  return { state: state as DurableObjectState, alarmAt: () => alarmAt };
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await seedDevData(d1);
  queueMessages = [];
  queueFailure = null;
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "dev-eli-lin@ecotech.tw", email: "eli-lin@ecotech.tw", name: "林瑞翔", pictureUrl: "" }), SECRET))}`;
});
afterEach(() => d1.sqlite.close());

describe("薪資背景 Queue 與 Durable Object", () => {
  it("建立工作後立即回傳 202，重複 requestId 仍沿用同一工作", async () => {
    const first = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-request-1",
    });
    expect(first.status, await first.clone().text()).toBe(202);
    const firstBody = await first.json() as { job: { jobId: string; status: string; dispatchPending: boolean } };
    expect(firstBody.job).toEqual(expect.objectContaining({ status: "queued", dispatchPending: false }));
    expect(queueMessages).toHaveLength(1);

    const repeat = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-request-1",
    });
    expect(repeat.status, await repeat.clone().text()).toBe(202);
    const repeatBody = await repeat.json() as { job: { jobId: string } };
    expect(repeatBody.job.jobId).toBe(firstBody.job.jobId);
    expect(queueMessages).toHaveLength(1);
  });

  it("Queue 暫時不可用時保留 outbox pending，之後可由相同 requestId 補送", async () => {
    queueFailure = new Error("queue unavailable");
    const first = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-dispatch-failure",
    });
    expect(first.status, await first.clone().text()).toBe(202);
    expect((await first.json() as { job: { status: string; dispatchPending: boolean; error: string | null } }).job).toEqual(expect.objectContaining({ status: "queued", dispatchPending: true, error: "queue unavailable" }));

    queueFailure = null;
    const replay = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-dispatch-failure",
    });
    expect(replay.status, await replay.clone().text()).toBe(202);
    expect((await replay.json() as { job: { status: string; dispatchPending: boolean } }).job).toEqual(expect.objectContaining({ status: "queued", dispatchPending: false }));
    expect(queueMessages).toHaveLength(1);
  });

  it("Queue consumer 耗盡重試時保留訊息進 DLQ 並標記尚未開始的工作失敗", async () => {
    const created = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-consumer-terminal",
    });
    const createdBody = await created.json() as { job: { jobId: string } };
    const consumerEnv = {
      ...(testEnv() as unknown as Record<string, unknown>),
      PAYROLL_RUN_AGENT: { getByName: () => ({ fetch: async () => new Response("temporary failure", { status: 503 }) }) } as unknown as DurableObjectNamespace,
    } as never;
    const attempts = [1, 2, 3].map((attempts) => ({ attempts, retried: false, acked: false }));
    for (const message of attempts) {
      const batchMessage = {
        id: `payroll-consumer-${message.attempts}`,
        timestamp: new Date(),
        body: { kind: "payroll", jobId: createdBody.job.jobId } as PayrollQueueMessage,
        attempts: message.attempts,
        ack: () => { message.acked = true; },
        retry: () => { message.retried = true; },
      };
      await queue({ queue: "rueisiang-payroll", messages: [batchMessage] } as never, consumerEnv);
      expect(message).toEqual(expect.objectContaining({ retried: true, acked: false }));
    }
    const terminalMessage = {
      id: "payroll-consumer-4",
      timestamp: new Date(),
      body: { kind: "payroll", jobId: createdBody.job.jobId } as PayrollQueueMessage,
      attempts: 4,
      ack: () => { throw new Error("terminal payroll message must not be acked"); },
      retry: () => { throw new Error("terminal payroll message must be left for DLQ"); },
    };
    await expect(queue({ queue: "rueisiang-payroll", messages: [terminalMessage] } as never, consumerEnv)).rejects.toThrow("啟動失敗（503）");
    const failed = await request(`/hr/payroll/jobs/${createdBody.job.jobId}`);
    expect((await failed.json() as { job: { status: string; dispatchPending: boolean; error: string | null } }).job).toEqual(expect.objectContaining({ status: "failed", dispatchPending: false, error: expect.stringContaining("重試 3 次後仍失敗") }));
  });

  it("Queue 派送連續失敗時進入 failed terminal state，停止 outbox 無限重送", async () => {
    queueFailure = new Error("permanent queue failure");
    const payload = { periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-dispatch-terminal" };
    await request("/hr/payroll/calculate", "POST", payload);
    await request("/hr/payroll/calculate", "POST", payload);
    const third = await request("/hr/payroll/calculate", "POST", payload);
    expect(third.status, await third.clone().text()).toBe(202);
    expect((await third.json() as { job: { status: string; dispatchPending: boolean; error: string | null } }).job).toEqual(expect.objectContaining({ status: "failed", dispatchPending: false, error: expect.stringContaining("派送失敗 3 次") }));
    expect(queueMessages).toHaveLength(0);
  });

  it("指定員工清單超過輸入上限時不建立背景工作", async () => {
    const response = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: Array.from({ length: 81 }, (_, index) => `employee-${index}`), requestId: "async-payroll-too-many-employees",
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(queueMessages).toHaveLength(0);
  });

  it("DO alarm 會更新進度，完成後建立可覆核的薪資紀錄", async () => {
    const created = await request("/hr/payroll/calculate", "POST", {
      periodKey: "2026-08", employeeUserIds: ["dev-eli-lin@ecotech.tw"], expectedCount: 1, requestId: "async-payroll-run-1",
    });
    const createdBody = await created.json() as { job: { jobId: string } };
    const local = doState();
    const agent = new PayrollRunAgent(local.state, testEnv());
    const accepted = await agent.fetch(new Request("https://payroll-run/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "payroll", jobId: createdBody.job.jobId }),
    }));
    expect(accepted.status).toBe(200);
    const firstAlarmAt = local.alarmAt();
    await agent.fetch(new Request("https://payroll-run/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "payroll", jobId: createdBody.job.jobId }),
    }));
    expect(local.alarmAt()).toBe(firstAlarmAt);
    await agent.alarm();

    const result = await request(`/hr/payroll/jobs/${createdBody.job.jobId}`);
    expect(result.status, await result.clone().text()).toBe(200);
    const resultBody = await result.json() as { job: { jobId: string; requestId: string; status: string; phase: string; progressPercent: number; runId: string | null; completedCount: number } };
    expect(resultBody.job).toEqual(expect.objectContaining({ status: "ready", phase: "completed", progressPercent: 100, completedCount: 1 }));
    expect(resultBody.job.runId).toEqual(expect.any(String));

    // 模擬「薪資結果已寫入，但 job ready 更新失敗」後的人工重試；同一 requestId 必須回到既有 run。
    d1.sqlite.prepare("UPDATE hr_payroll_jobs SET status='failed', phase='failed' WHERE id=?").run(resultBody.job.jobId);
    const retried = await request(`/hr/payroll/jobs/${resultBody.job.jobId}/retry`, "POST", {});
    expect(retried.status, await retried.clone().text()).toBe(202);
    const retriedBody = await retried.json() as { job: { jobId: string; requestId: string; status: string } };
    expect(retriedBody.job).toEqual(expect.objectContaining({ jobId: resultBody.job.jobId, requestId: resultBody.job.requestId, status: "queued" }));
    await agent.fetch(new Request("https://payroll-run/start", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "payroll", jobId: resultBody.job.jobId }),
    }));
    await agent.alarm();
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_payroll_runs").get()).toEqual({ count: 1 });
    const retriedStatus = await request(`/hr/payroll/jobs/${resultBody.job.jobId}`);
    expect((await retriedStatus.json() as { job: { status: string; runId: string | null; dispatchPending: boolean } }).job).toEqual(expect.objectContaining({ status: "ready", runId: resultBody.job.runId, dispatchPending: false }));

    const records = await request("/hr/payroll/records?periodKey=2026-08&status=unsettled");
    expect(records.status).toBe(200);
    expect((await records.json() as { total: number }).total).toBeGreaterThanOrEqual(1);
  });
});
