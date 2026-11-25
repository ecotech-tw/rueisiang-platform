import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rueisiang/db", () => ({
  createDatabase: vi.fn((db) => db),
  updateShopeeSalesRun: vi.fn().mockResolvedValue(undefined),
}));

import { updateShopeeSalesRun } from "@rueisiang/db";
import { ReportRunner } from "./report-runner-container.js";

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
      setAlarm: async (time: number) => { alarmAt = time; },
      deleteAlarm: async () => { alarmAt = null; },
    },
  };
}

describe("ReportRunner Durable Object", () => {
  beforeEach(() => {
    vi.mocked(updateShopeeSalesRun).mockReset().mockResolvedValue(undefined);
  });

  it("將背景工作狀態持久化，並由 alarm 在 Container 完成後保存終態", async () => {
    const durable = fakeStorage();
    let remoteJob: Record<string, unknown> = { status: "running" };
    let containerCalls = 0;
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: "runner-secret",
      GOOGLE_REPORTS_OAUTH_CLIENT_ID: "reports-client-id",
      GOOGLE_REPORTS_OAUTH_CLIENT_SECRET: "reports-client-secret",
      GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: "drive-refresh-token",
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
    const requestId = "request-1234567890";

    const accepted = await runner.fetch(new Request("https://runner/jobs", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    }));
    expect(accepted.status).toBe(200);
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "running" });
    expect(durable.alarmAt).not.toBeNull();

    remoteJob = { status: "succeeded", result: { salesRows: 3 }, finishedAt: "2026-08-15T00:00:00.000Z" };
    await runner.alarm();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "succeeded", result: { salesRows: 3 } });

    const completed = await runner.fetch(new Request(`https://runner/jobs/${requestId}`));
    expect(await completed.json()).toMatchObject({ status: "succeeded", result: { salesRows: 3 } });
    expect(containerCalls).toBe(2);
  });

  it("D1 終態寫入失敗時保留非終態並重排 alarm", async () => {
    const durable = fakeStorage();
    let remoteJob: Record<string, unknown> = { status: "running" };
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: "runner-secret",
      DB: {},
      containerFetch: async () => Response.json(remoteJob),
    } as never);
    const requestId = "request-1234567890";

    await runner.fetch(new Request("https://runner/jobs", {
      method: "POST",
      body: JSON.stringify({ requestId }),
    }));
    remoteJob = { status: "succeeded", result: { salesRows: 3 } };
    vi.mocked(updateShopeeSalesRun).mockRejectedValueOnce(new Error("temporary D1 failure"));

    await runner.alarm();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "running" });
    expect(durable.alarmAt).not.toBeNull();

    await runner.alarm();
    expect(durable.values.get(`job:${requestId}`)).toMatchObject({ status: "succeeded" });
    expect(vi.mocked(updateShopeeSalesRun)).toHaveBeenCalledTimes(3);
  });

  it("未知工作的狀態查詢不啟動 Container", async () => {
    const durable = fakeStorage();
    let containerCalls = 0;
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: "runner-secret",
      containerFetch: async () => {
        containerCalls += 1;
        return Response.json({ status: "failed" });
      },
    } as never);

    const response = await runner.fetch(new Request("https://runner/jobs/request-1234567890"));
    expect(response.status).toBe(404);
    expect(containerCalls).toBe(0);
  });
});
