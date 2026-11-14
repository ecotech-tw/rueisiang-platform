import { describe, expect, it } from "vitest";
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
  it("將背景工作狀態持久化，並由 alarm 在 Container 完成後保存終態", async () => {
    const durable = fakeStorage();
    let remoteJob: Record<string, unknown> = { status: "running" };
    let containerCalls = 0;
    const runner = new ReportRunner({ storage: durable.storage } as never, {
      REPORT_RUNNER_TOKEN: "runner-secret",
      containerFetch: async () => {
        containerCalls += 1;
        return Response.json(remoteJob);
      },
    } as never);
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
});
