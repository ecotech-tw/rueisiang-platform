import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rueisiang/db", () => ({
  createDatabase: vi.fn((db) => db),
  updateReportRun: vi.fn().mockResolvedValue(undefined),
}));

import { updateReportRun } from "@rueisiang/db";
import { ReportRunner } from "./report-runner-container.js";

const RUNNER_TOKEN = "runner-secret";

function fakeStorage() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  return {
    values,
    get alarmAt() { return alarmAt; },
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      list: async <T>({ prefix }: { prefix: string }) => new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
      delete: async (key: string) => values.delete(key),
      transaction: async <T>(callback: (transaction: any) => Promise<T>) => {
        const snapshot = new Map(values);
        const transaction = {
          get: async <V>(key: string) => values.get(key) as V | undefined,
          put: async (key: string, value: unknown) => { values.set(key, value); },
          list: async <V>({ prefix }: { prefix: string }) => new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))) as Map<string, V>,
          delete: async (key: string | string[]) => {
            if (Array.isArray(key)) return key.filter((entry) => values.delete(entry)).length;
            return values.delete(key);
          },
        };
        try {
          return await callback(transaction);
        } catch (error) {
          values.clear();
          for (const [key, value] of snapshot) values.set(key, value);
          throw error;
        }
      },
      setAlarm: async (time: number) => { alarmAt = time; },
      deleteAlarm: async () => { alarmAt = null; },
    },
  };
}

function runnerRequest(path: string, method = "GET", body?: unknown, shared = false): Request {
  return new Request(`https://runner${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${RUNNER_TOKEN}`,
      ...(body === undefined ? {} : {
        "Content-Type": "application/json",
        ...(shared ? { "X-Report-Runner-Mode": "shared" } : {}),
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("ReportRunner Durable Object", () => {
  beforeEach(() => {
    vi.mocked(updateReportRun).mockReset().mockResolvedValue(undefined);
  });

  it("將舊版 requestId 專屬工作的狀態持久化，並由 alarm 保存終態", async () => {
    const durable = fakeStorage();
    let remoteJob: Record<string, unknown> = { status: "running" };
    let containerCalls = 0;
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      GOOGLE_REPORTS_OAUTH_CLIENT_ID: "reports-client-id",
      GOOGLE_REPORTS_OAUTH_CLIENT_SECRET: "reports-client-secret",
      GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: "drive-refresh-token",
      GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN: "gmail-refresh-token",
      CYBERBIZ_USERNAME: "cyberbiz-user",
      CYBERBIZ_PASSWORD: "cyberbiz-password",
      DB: {},
      containerFetch: async () => {
        containerCalls += 1;
        return Response.json(remoteJob);
      },
    } as never);
    expect(runner.envVars).toMatchObject({
      GOOGLE_REPORTS_OAUTH_CLIENT_ID: "reports-client-id",
      GOOGLE_REPORTS_OAUTH_CLIENT_SECRET: "reports-client-secret",
      GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: "drive-refresh-token",
    });
    expect(runner.envVars).not.toHaveProperty("GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN");
    expect(runner.envVars).not.toHaveProperty("CYBERBIZ_USERNAME");
    expect(runner.envVars).not.toHaveProperty("CYBERBIZ_PASSWORD");
    const requestId = "request-1234567890";

    const accepted = await runner.fetch(runnerRequest("/jobs", "POST", { requestId }));
    expect(accepted.status).toBe(200);
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "running" });
    expect(durable.alarmAt).not.toBeNull();

    remoteJob = { status: "succeeded", result: { salesRows: 3 }, finishedAt: "2026-08-15T00:00:00.000Z" };
    await runner.alarm();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "succeeded", result: { salesRows: 3 } });

    const completed = await runner.fetch(runnerRequest(`/jobs/${requestId}`));
    expect(await completed.json()).toMatchObject({ status: "succeeded", result: { salesRows: 3 } });
    expect(containerCalls).toBe(2);
  });

  it("超過 60 分鐘的 active job 會終止 Container 並釋放共享佇列", async () => {
    const durable = fakeStorage();
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      DB: {},
    } as never);
    const destroy = vi.spyOn(runner, "destroy").mockResolvedValue(undefined);
    const requestId = "stalled-request-12345";
    const startedAt = Date.now() - 61 * 60_000;
    durable.values.set("report-runner:active-job", { requestId, phase: "running", attempts: 0, startedAt });
    durable.values.set(`queue:${requestId}`, {
      requestId,
      pathname: "/jobs",
      payload: { requestId },
      queuedAt: startedAt,
      attempts: 0,
      retryAt: startedAt,
    });
    durable.values.set(`job:${requestId}`, { requestId, status: "running" });

    await runner.processQueuedJobs();

    expect(destroy).toHaveBeenCalledOnce();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({
      status: "failed",
      error: "報表執行超過 60 分鐘，已停止；請查看摘要、分批或重新提交。",
    });
    expect(durable.values.has(`queue:${requestId}`)).toBe(false);
    expect(durable.values.has("report-runner:active-job")).toBe(false);
  });

  it("共享 DO 會把多筆工作排隊，並只讓一筆工作占用 Container", async () => {
    const durable = fakeStorage();
    const remoteJobs = new Map<string, Record<string, unknown>>();
    const calls: string[] = [];
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      DB: {},
      containerFetch: async (request: Request) => {
        const url = new URL(request.url);
        const requestId = url.pathname.split("/").at(-1) ?? "";
        if (request.method === "POST") {
          const payload = await request.json() as { requestId: string };
          calls.push(`start:${payload.requestId}`);
          const job = { requestId: payload.requestId, status: "running", result: null, error: "" };
          remoteJobs.set(payload.requestId, job);
          return Response.json(job, { status: 202 });
        }
        calls.push(`poll:${requestId}`);
        const job = remoteJobs.get(requestId);
        return job ? Response.json(job) : Response.json({ error: "job_not_found" }, { status: 404 });
      },
    } as never);

    const firstId = "first-request-123456";
    const secondId = "second-request-12345";
    const first = await runner.fetch(runnerRequest("/preview", "POST", { requestId: firstId }, true));
    const second = await runner.fetch(runnerRequest("/jobs", "POST", { requestId: secondId }, true));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: "queued" });
    expect(calls).toEqual([]);

    await runner.processQueuedJobs();
    expect(calls).toEqual([`start:${firstId}`]);
    expect(durable.values.get(`job:${secondId}`)).toMatchObject({ status: "queued" });
    expect(durable.values.get("report-runner:active-job")).toMatchObject({ requestId: firstId, phase: "running" });

    remoteJobs.set(firstId, { requestId: firstId, status: "succeeded", result: { preview: true } });
    await runner.processQueuedJobs();
    expect(durable.values.get(`job:${firstId}`)).toMatchObject({ status: "succeeded" });
    expect(durable.values.get("report-runner:active-job")).toBeUndefined();

    await runner.processQueuedJobs();
    expect(calls).toEqual([`start:${firstId}`, `poll:${firstId}`, `start:${secondId}`]);
    expect(durable.values.get("report-runner:active-job")).toMatchObject({ requestId: secondId, phase: "running" });
  });

  it("只對 CYBERBIZ job 短暫注入帳密與 Gmail token，且不持久化在 DO queue", async () => {
    const durable = fakeStorage();
    const sentPayloads: Record<string, unknown>[] = [];
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      CYBERBIZ_USERNAME: "cyberbiz-user",
      CYBERBIZ_PASSWORD: "cyberbiz-password",
      GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN: "gmail-refresh-token",
      DB: {},
      containerFetch: async (request: Request) => {
        if (request.method === "POST") sentPayloads.push(await request.json() as Record<string, unknown>);
        return Response.json({ requestId: "cyberbiz-request-123", status: "running" }, { status: 202 });
      },
    } as never);
    const payload = {
      kind: "cyberbiz-sales",
      requestId: "cyberbiz-request-123",
      stores: [{ scopeId: "scope-1", name: "測試店", driveFolderUrl: "https://drive.google.com/drive/folders/id", driveFolderName: "測試" }],
      start: "2026-07-01",
      end: "2026-07-31",
    };

    await runner.fetch(runnerRequest("/jobs", "POST", payload, true));
    const queued = [...durable.values.entries()].find(([key]) => key.startsWith("queue:"))?.[1] as { payload?: Record<string, unknown> } | undefined;
    expect(queued?.payload).not.toHaveProperty("credentials");

    await runner.processQueuedJobs();
    expect(sentPayloads[0]?.credentials).toEqual({
      cyberbizUsername: "cyberbiz-user",
      cyberbizPassword: "cyberbiz-password",
      gmailRefreshToken: "gmail-refresh-token",
    });
    expect(JSON.stringify([...durable.values.values()])).not.toContain("cyberbiz-password");
    expect(JSON.stringify([...durable.values.values()])).not.toContain("gmail-refresh-token");
  });

  it("重疊的排程回呼不會重複啟動同一筆工作", async () => {
    const durable = fakeStorage();
    let containerCalls = 0;
    let resolveResponse: ((response: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      containerFetch: async () => {
        containerCalls += 1;
        signalStarted?.();
        return new Promise<Response>((resolve) => { resolveResponse = resolve; });
      },
    } as never);
    const requestId = "overlap-request-12345";

    await runner.fetch(runnerRequest("/jobs", "POST", { requestId }, true));
    const firstRun = runner.processQueuedJobs();
    await started;
    await runner.processQueuedJobs();
    resolveResponse?.(Response.json({ requestId, status: "running" }, { status: 202 }));
    await firstRun;

    expect(containerCalls).toBe(1);
    expect(durable.values.get("report-runner:active-job")).toMatchObject({ requestId, phase: "running" });
  });

  it("容量持續不足時退避重試至 24 小時佇列期限，而非固定次數後丟棄", async () => {
    const durable = fakeStorage();
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      containerFetch: async () => { throw new Error("Maximum number of running container instances exceeded"); },
    } as never);
    const requestId = "capacity-request-12345";

    await runner.fetch(runnerRequest("/jobs", "POST", { requestId }, true));
    const queued = durable.values.get(`queue:${requestId}`) as { queuedAt: number; pathname: string; payload: Record<string, unknown>; attempts: number; retryAt: number };
    durable.values.set(`queue:${requestId}`, { ...queued, queuedAt: Date.now() - 60 * 60 * 1000, attempts: 11, retryAt: Date.now() - 1 });
    await runner.processQueuedJobs();

    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "queued" });
    expect(durable.values.get(`queue:${requestId}`)).toMatchObject({ attempts: 12, retryAt: expect.any(Number) });
    expect(durable.values.get("report-runner:active-job")).toBeUndefined();
    expect(durable.alarmAt).toBeGreaterThan(Date.now());
  });

  it("入列排程失敗時回滾新工作的 DO 狀態", async () => {
    const durable = fakeStorage();
    durable.storage.setAlarm = async () => { throw new Error("alarm unavailable"); };
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
    } as never);
    const requestId = "schedule-failure-12345";

    await expect(runner.fetch(runnerRequest("/jobs", "POST", { requestId }, true))).rejects.toThrow("alarm unavailable");
    expect(durable.values.has(`job:${requestId}`)).toBe(false);
    expect(durable.values.has(`queue:${requestId}`)).toBe(false);
  });

  it("佇列工作超過期限時清除未讀取的暫存報表", async () => {
    const durable = fakeStorage();
    const deleteUpload = vi.fn().mockResolvedValue(undefined);
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      UPLOADS: { delete: deleteUpload },
    } as never);
    const requestId = "expired-request-123456";
    const token = "source-token-123456789";

    await runner.fetch(runnerRequest("/jobs", "POST", {
      requestId,
      sourceUrl: `https://platform.rueisiang.com/api/internal/shopee-sales/source/${requestId}?token=${token}`,
    }, true));
    const queued = durable.values.get(`queue:${requestId}`) as { queuedAt: number; retryAt: number };
    durable.values.set(`queue:${requestId}`, { ...queued, queuedAt: Date.now() - 25 * 60 * 60 * 1000, retryAt: Date.now() });
    await runner.processQueuedJobs();

    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "failed" });
    expect(deleteUpload).toHaveBeenCalledWith(`shopee-sales/${requestId}/${token}.xlsx`);
    expect(durable.values.has(`queue:${requestId}`)).toBe(false);
  });

  it("D1 終態寫入失敗時保留終態工作並排程重試", async () => {
    const durable = fakeStorage();
    const remoteJobs = new Map<string, Record<string, unknown>>();
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      DB: {},
      containerFetch: async (request: Request) => {
        const requestId = new URL(request.url).pathname.split("/").at(-1) ?? "";
        if (request.method === "POST") {
          const job = { requestId, status: "running" };
          remoteJobs.set(requestId, job);
          return Response.json(job, { status: 202 });
        }
        const job = remoteJobs.get(requestId);
        return job ? Response.json(job) : Response.json({ error: "job_not_found" }, { status: 404 });
      },
    } as never);
    const requestId = "persist-request-123456";

    await runner.fetch(runnerRequest("/jobs", "POST", { requestId }, true));
    await runner.processQueuedJobs();
    remoteJobs.set(requestId, { requestId, status: "succeeded", result: { salesRows: 3 } });
    vi.mocked(updateReportRun).mockRejectedValueOnce(new Error("temporary D1 failure"));

    await runner.processQueuedJobs();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "succeeded" });
    expect(durable.values.get("report-runner:active-job")).toMatchObject({ requestId });
    expect(durable.alarmAt).not.toBeNull();

    await runner.processQueuedJobs();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "succeeded" });
    expect(durable.values.get("report-runner:active-job")).toBeUndefined();
    expect(vi.mocked(updateReportRun)).toHaveBeenCalledTimes(3);
  });

  it("未知工作的狀態查詢不啟動 Container", async () => {
    const durable = fakeStorage();
    let containerCalls = 0;
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: RUNNER_TOKEN,
      containerFetch: async () => {
        containerCalls += 1;
        return Response.json({ status: "failed" });
      },
    } as never);

    await runner.fetch(runnerRequest("/jobs", "POST", { requestId: "known-request-123456" }, true));
    const response = await runner.fetch(runnerRequest("/jobs/unknown-request-12345"));
    expect(response.status).toBe(404);
    expect(containerCalls).toBe(0);
  });
});
