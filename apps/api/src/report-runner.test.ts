import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import {
  containerJobStatus,
  containerRunnerConfigured,
  cyberbizRunnerConfigured,
  isContainerRequestId,
  newContainerRequestId,
  readContainerJob,
  submitContainerJob,
  usesContainerRunner,
} from "./report-runner.js";

const runnerSecrets = {
  CYBERBIZ_USERNAME: "operator",
  CYBERBIZ_PASSWORD: "password",
  GOOGLE_REPORTS_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_REPORTS_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: "drive-token",
  GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN: "gmail-token",
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    ...runnerSecrets,
    REPORT_RUNNER_TOKEN: "runner-token",
    REPORT_RUNNER: {} as DurableObjectNamespace,
    CYBERBIZ_REPORT_RUNNER_MODE: "container",
    ...overrides,
  } as Env;
}

describe("CYBERBIZ report runner routing", () => {
  it("only reports Container ready when its binding and all required secrets exist", () => {
    expect(usesContainerRunner(env())).toBe(true);
    expect(containerRunnerConfigured(env())).toBe(true);
    expect(containerRunnerConfigured(env({ GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN: "" }))).toBe(false);
    expect(containerRunnerConfigured(env({ REPORT_RUNNER: undefined }))).toBe(false);
    expect(cyberbizRunnerConfigured(env({ CYBERBIZ_REPORT_RUNNER_MODE: "github" }), true)).toBe(true);
  });

  it("marks Container request IDs so old GitHub Actions jobs remain trackable", () => {
    const requestId = newContainerRequestId();
    expect(requestId).toMatch(/^cf-[0-9a-f-]{36}$/);
    expect(isContainerRequestId(requestId)).toBe(true);
    expect(isContainerRequestId("legacy-github-request-id")).toBe(false);
  });

  it("submits through the shared ReportRunner DO with the shared-queue header", async () => {
    const responseJob = { requestId: "cf-request-123456", status: "queued" };
    const fetch = vi.fn().mockResolvedValue(Response.json(responseJob, { status: 202 }));
    const idFromName = vi.fn().mockReturnValue("shared-id");
    const get = vi.fn().mockReturnValue({ fetch });
    const configured = env({ REPORT_RUNNER: { idFromName, get } as never });
    const payload = {
      kind: "cyberbiz-sales" as const,
      requestId: responseJob.requestId,
      start: "2026-07-01",
      end: "2026-07-31",
      stores: [{ scopeId: "cyberbiz:store:one", name: "Store", driveFolderUrl: "https://drive.google.com/drive/folders/1", driveFolderName: "Store" }],
    };

    await expect(submitContainerJob(configured, payload)).resolves.toEqual(responseJob);
    expect(idFromName).toHaveBeenCalledWith("shared");
    expect(fetch).toHaveBeenCalledWith("https://report-runner/jobs", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer runner-token",
        "x-report-runner-mode": "shared",
      }),
    }));
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual(payload);
  });

  it("shows a terminal failure instead of polling forever if a Container job is missing", () => {
    expect(containerJobStatus(null, "cf-missing-request")).toMatchObject({
      runs: [{ status: "completed", conclusion: "failure", error: "找不到這次報表的執行狀態，請重新提交。" }],
    });
  });

  it("maps Container phases and per-store steps to the existing workflow panel contract", () => {
    expect(containerJobStatus({ requestId: "cf-id", status: "running", progress: "登入 CYBERBIZ…" }).steps).toEqual([
      { name: "登入 CYBERBIZ…", status: "in_progress", conclusion: null },
    ]);
    expect(containerJobStatus({
      requestId: "cf-id",
      status: "succeeded",
      result: {
        stores: [{ store: "宏匯", done: true, steps: { export: "ok", ingest: "skip" } }],
        reportMarkdown: "完成",
      },
    })).toEqual({
      runs: [{ id: 0, status: "completed", conclusion: "success", title: "cf-id", reportMarkdown: "完成" }],
      steps: [
        { name: "宏匯・匯出", status: "completed", conclusion: "success" },
        { name: "宏匯・匯入 D1", status: "completed", conclusion: "success" },
      ],
    });
  });

  it("reads shared DO status without requiring GitHub configuration", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ requestId: "cf-request-123456", status: "running" }));
    const configured = env({ REPORT_RUNNER: { idFromName: () => "shared", get: () => ({ fetch }) } as never });
    await expect(readContainerJob(configured, "cf-request-123456")).resolves.toMatchObject({ status: "running" });
    expect(fetch).toHaveBeenCalledWith("https://report-runner/jobs/cf-request-123456", {
      headers: { Authorization: "Bearer runner-token" },
    });
  });
});
