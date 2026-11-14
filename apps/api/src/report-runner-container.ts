import { Container } from "@cloudflare/containers";
import { createDatabase, updateShopeeSalesRun } from "@rueisiang/db";
import type { Env } from "./env.js";

const RUNNER_PORT = 8080;

export class ReportRunner extends Container<Env> {
  private readonly durableState: DurableObjectState<{}>;

  override defaultPort = RUNNER_PORT;
  override requiredPorts = [RUNNER_PORT];
  override sleepAfter = "2h";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.durableState = ctx;
    this.enableInternet = true;
    this.allowedHosts = [
      new URL(env.SHOPEE_SOURCE_BASE_URL ?? env.PUBLIC_APP_URL ?? "https://platform.rueisiang.com").hostname,
      "oauth2.googleapis.com",
      "www.googleapis.com",
    ];
    this.envVars = {
      REPORT_RUNNER_TOKEN: env.REPORT_RUNNER_TOKEN ?? "",
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "",
      GOOGLE_REFRESH_TOKEN: env.GOOGLE_REFRESH_TOKEN ?? "",
      CYBERBIZ_REPORT_INGEST_TOKEN: env.CYBERBIZ_REPORT_INGEST_TOKEN ?? "",
      PLATFORM_API_URL: env.PUBLIC_APP_URL ?? "https://platform.rueisiang.com",
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const allowedPath = url.pathname === "/preview" || url.pathname === "/jobs"
      || /^\/jobs\/[A-Za-z0-9-]{16,80}$/.test(url.pathname);
    if (!allowedPath) return new Response("Not found", { status: 404 });
    if ((url.pathname === "/preview" || url.pathname === "/jobs") && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname.startsWith("/jobs/") && request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!this.env.REPORT_RUNNER_TOKEN) return new Response("Runner secret is not configured", { status: 503 });

    const submitted = request.method === "POST"
      ? await request.clone().json().catch(() => null) as { requestId?: string } | null
      : null;
    const jobId = /^\/jobs\/([A-Za-z0-9-]{16,80})$/.exec(url.pathname)?.[1]
      ?? (submitted?.requestId && /^[A-Za-z0-9-]{16,80}$/.test(submitted.requestId) ? submitted.requestId : undefined);
    const saved = jobId ? await this.durableState.storage.get<RunnerJob>(`job:${jobId}`) : undefined;
    if (request.method === "GET" && saved && isTerminal(saved.status)) return Response.json(saved);
    if (request.method === "POST" && saved) return Response.json(saved, { status: 202 });

    await this.startAndWaitForPorts();
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.env.REPORT_RUNNER_TOKEN}`);
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const response = await this.containerFetch(new Request(`http://report-runner${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
    }));
    if (response.ok && jobId) {
      const job = await response.clone().json() as RunnerJob;
      await this.durableState.storage.put(`job:${jobId}`, job);
      if (isTerminal(job.status)) await this.persistTerminal(jobId, job);
      else {
        if (saved?.status !== "running") await this.persistRunning(jobId);
        await this.durableState.storage.setAlarm(Date.now() + 10_000);
      }
    }
    return response;
  }

  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    await super.alarm(alarmProps);
    const entries = await this.durableState.storage.list<RunnerJob>({ prefix: "job:" });
    const [key, job] = [...entries.entries()][0] ?? [];
    if (!key || !job || isTerminal(job.status)) return;
    const requestId = key.slice("job:".length);
    try {
      await this.startAndWaitForPorts();
      const response = await this.containerFetch(new Request(`http://report-runner/jobs/${requestId}`, {
        headers: { Authorization: `Bearer ${this.env.REPORT_RUNNER_TOKEN ?? ""}` },
      }));
      if (response.ok) {
        const current = await response.json() as RunnerJob;
        await this.durableState.storage.put(key, current);
        if (isTerminal(current.status)) {
          await this.persistTerminal(requestId, current);
          return;
        }
      } else if (response.status === 404) {
        const failedJob = {
          ...job,
          status: "failed",
          error: "報表執行環境重新啟動，工作狀態遺失。",
          finishedAt: new Date().toISOString(),
        };
        await this.durableState.storage.put(key, failedJob);
        await this.persistTerminal(requestId, failedJob);
        return;
      }
    } catch (error) {
      console.error("report runner status poll failed", error);
    }
    await this.durableState.storage.setAlarm(Date.now() + 10_000);
  }

  private async persistRunning(requestId: string): Promise<void> {
    if (!this.env.DB) return;
    await updateShopeeSalesRun(createDatabase(this.env.DB), { requestId, status: "running" });
  }

  private async persistTerminal(requestId: string, job: RunnerJob): Promise<void> {
    if (!this.env.DB) return;
    const result = job.result as { salesRows?: number; payoutRows?: number } | null;
    await updateShopeeSalesRun(createDatabase(this.env.DB), {
      requestId,
      status: job.status === "succeeded" ? "succeeded" : "failed",
      lastError: typeof job.error === "string" ? job.error : "",
      importedSalesRows: result?.salesRows,
      importedPayoutRows: result?.payoutRows,
    });
  }
}

type RunnerJob = { status: string; [key: string]: unknown };

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed";
}
