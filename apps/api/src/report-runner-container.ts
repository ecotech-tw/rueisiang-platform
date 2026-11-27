import { Container } from "@cloudflare/containers";
import { createDatabase, updateReportRun } from "@rueisiang/db";
import type { Env } from "./env.js";

const RUNNER_PORT = 8080;
const SHARED_MODE_HEADER = "x-report-runner-mode";
const SHARED_MODE_KEY = "report-runner:shared-mode";
const ACTIVE_JOB_KEY = "report-runner:active-job";
const JOB_PREFIX = "job:";
const QUEUE_PREFIX = "queue:";
const QUEUE_CALLBACK = "processQueuedJobs";
const MAX_QUEUED_JOBS = 20;
const MAX_ACTIVE_POLL_RETRIES = 12;
const MAX_ACTIVE_JOB_MS = 60 * 60_000;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 10_000;

interface RunnerJob {
  requestId: string;
  status: string;
  error?: string;
  result?: unknown;
  updatedAtMs?: number;
  [key: string]: unknown;
}

interface QueueItem {
  requestId: string;
  pathname: "/preview" | "/jobs";
  payload: Record<string, unknown>;
  queuedAt: number;
  attempts: number;
  retryAt: number;
}

interface ActiveJob {
  requestId: string;
  phase: "starting" | "running";
  attempts: number;
  startedAt: number;
}

export class ReportRunner extends Container<Env> {
  private readonly durableState: DurableObjectState<{}>;
  private queueProcessing = false;

  override defaultPort = RUNNER_PORT;
  override requiredPorts = [RUNNER_PORT];
  override sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.durableState = ctx;
    this.enableInternet = true;
    this.allowedHosts = [
      new URL(env.SHOPEE_SOURCE_BASE_URL ?? env.PUBLIC_APP_URL ?? "https://platform.rueisiang.com").hostname,
      "oauth2.googleapis.com",
      "www.googleapis.com",
      "gmail.googleapis.com",
      "drive.google.com",
      "challenges.cloudflare.com",
      "*.cyberbiz.co",
    ];
    this.envVars = {
      REPORT_RUNNER_TOKEN: env.REPORT_RUNNER_TOKEN ?? "",
      GOOGLE_REPORTS_OAUTH_CLIENT_ID: env.GOOGLE_REPORTS_OAUTH_CLIENT_ID ?? "",
      GOOGLE_REPORTS_OAUTH_CLIENT_SECRET: env.GOOGLE_REPORTS_OAUTH_CLIENT_SECRET ?? "",
      GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: env.GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN ?? "",
      CYBERBIZ_REPORT_INGEST_TOKEN: env.CYBERBIZ_REPORT_INGEST_TOKEN ?? "",
      CYBERBIZ_CHALLENGE_CLICK_ENABLED: env.CYBERBIZ_CHALLENGE_CLICK_ENABLED === "true" ? "true" : "false",
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
    if (request.headers.get("Authorization") !== `Bearer ${this.env.REPORT_RUNNER_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const sharedMode = await this.durableState.storage.get<boolean>(SHARED_MODE_KEY);
    const isSharedSubmission = request.method === "POST" && request.headers.get(SHARED_MODE_HEADER) === "shared";
    if (sharedMode || isSharedSubmission) {
      if (isSharedSubmission) {
        await this.durableState.storage.put(SHARED_MODE_KEY, true);
        return this.enqueue(request, url.pathname as QueueItem["pathname"]);
      }
      return this.readSharedJob(url.pathname);
    }

    // 舊版 requestId 專屬 DO 的相容路徑，讓部署中的工作可以完成。
    return this.fetchLegacy(request, url.pathname);
  }

  /** Queue callback managed by Container.schedule(), which preserves Container lifecycle alarms. */
  async processQueuedJobs(): Promise<void> {
    if (this.queueProcessing) {
      await this.scheduleQueueProcessing(POLL_INTERVAL_MS);
      return;
    }
    this.queueProcessing = true;
    try {
      await this.processQueueOnce();
    } catch (error) {
      console.error("report runner queue callback failed", { errorName: error instanceof Error ? error.name : "unknown" });
      await this.scheduleQueueProcessing(retryDelay(1));
    } finally {
      this.queueProcessing = false;
    }
  }

  private async processQueueOnce(): Promise<void> {
    const active = await this.durableState.storage.get<ActiveJob>(ACTIVE_JOB_KEY);
    if (active) {
      await this.processActiveJob(active);
      return;
    }

    const entries = await this.durableState.storage.list<QueueItem>({ prefix: QUEUE_PREFIX });
    const [queueKey, item] = [...entries.entries()]
      .sort((left, right) => left[1].queuedAt - right[1].queuedAt)[0] ?? [];
    if (!queueKey || !item) return;

    if (Date.now() - item.queuedAt >= MAX_QUEUE_AGE_MS) {
      await this.failJob(item.requestId, "報表排隊超過 24 小時，請重新提交報表。");
      return;
    }

    const delay = item.retryAt - Date.now();
    if (delay > 0) {
      await this.scheduleQueueProcessing(delay);
      return;
    }

    const starting: ActiveJob = { requestId: item.requestId, phase: "starting", attempts: 0, startedAt: Date.now() };
    await this.durableState.storage.put(ACTIVE_JOB_KEY, starting);
    await this.startQueuedJob(queueKey, item, starting);
  }

  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    await super.alarm(alarmProps);
    // 新的共用 DO 使用 Container.schedule()；舊 requestId DO 仍需完成原有 alarm 工作。
    if (await this.durableState.storage.get<boolean>(SHARED_MODE_KEY)) return;
    await this.pollLegacyJob();
  }

  private async enqueue(request: Request, pathname: QueueItem["pathname"]): Promise<Response> {
    const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    if (!body || !/^[A-Za-z0-9-]{16,80}$/.test(requestId)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      await this.pruneTerminalJobs();
    } catch (error) {
      console.warn("report runner history cleanup failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }

    const queuedAt = Date.now();
    const jobKey = `${JOB_PREFIX}${requestId}`;
    const queueKey = `${QUEUE_PREFIX}${requestId}`;
    const item: QueueItem = { requestId, pathname, payload: body, queuedAt, attempts: 0, retryAt: queuedAt };
    const outcome = await this.durableState.storage.transaction(async (transaction) => {
      const existing = await transaction.get<RunnerJob>(jobKey);
      if (existing) {
        if (isTerminal(existing.status)) return { kind: "existing" as const, job: existing };
        const existingItem = await transaction.get<QueueItem>(queueKey);
        if (existingItem) return { kind: "existing" as const, job: existing };
        const requeued: RunnerJob = { ...existing, status: "queued", updatedAtMs: queuedAt };
        await transaction.put(jobKey, requeued);
        await transaction.put(queueKey, item);
        return { kind: "existing" as const, job: requeued };
      }
      const queued = await transaction.list<QueueItem>({ prefix: QUEUE_PREFIX });
      if (queued.size >= MAX_QUEUED_JOBS) return { kind: "full" as const };
      const created: RunnerJob = { requestId, status: "queued", error: "", queuedAt, updatedAtMs: queuedAt };
      await transaction.put(jobKey, created);
      await transaction.put(queueKey, item);
      return { kind: "created" as const, job: created };
    });
    if (outcome.kind === "full") {
      return Response.json({ message: "報表執行佇列已滿，請稍後再試。" }, { status: 503 });
    }
    if (isTerminal(outcome.job.status)) return Response.json(outcome.job, { status: 202 });

    try {
      await this.scheduleQueueProcessing(0);
    } catch (error) {
      if (outcome.kind === "created") {
        await this.durableState.storage.transaction(async (transaction) => {
          const saved = await transaction.get<RunnerJob>(jobKey);
          if (saved?.status === "queued") await transaction.delete([jobKey, queueKey]);
        });
      }
      throw error;
    }
    return Response.json(outcome.job, { status: 202 });
  }

  private async readSharedJob(pathname: string): Promise<Response> {
    const requestId = /^\/jobs\/([A-Za-z0-9-]{16,80})$/.exec(pathname)?.[1];
    if (!requestId) return new Response("Method not allowed", { status: 405 });
    const job = await this.durableState.storage.get<RunnerJob>(`${JOB_PREFIX}${requestId}`);
    return job ? Response.json(job) : Response.json({ error: "job_not_found" }, { status: 404 });
  }

  private async startQueuedJob(queueKey: string, item: QueueItem, active: ActiveJob): Promise<void> {
    try {
      await this.startAndWaitForPorts();
      const isCyberbizJob = item.payload.kind === "cyberbiz-payout" || item.payload.kind === "cyberbiz-sales";
      const containerPayload = isCyberbizJob
        ? {
          ...item.payload,
          credentials: {
            cyberbizUsername: this.env.CYBERBIZ_USERNAME ?? "",
            cyberbizPassword: this.env.CYBERBIZ_PASSWORD ?? "",
            gmailRefreshToken: this.env.GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN ?? "",
          },
        }
        : item.payload;
      const response = await this.containerFetch(new Request(`http://report-runner${item.pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.REPORT_RUNNER_TOKEN ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(containerPayload),
      }));
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        const message = result?.message ?? result?.error ?? `報表 Container 回應 ${response.status}。`;
        if (response.status >= 500 || response.status === 429) throw new Error(message);
        await this.failJob(item.requestId, message);
        return;
      }

      const job = await response.json() as RunnerJob;
      const running: ActiveJob = { ...active, phase: "running" };
      const storedJob = { ...job, requestId: item.requestId, updatedAtMs: Date.now() };
      await this.durableState.storage.put(ACTIVE_JOB_KEY, running);
      await this.durableState.storage.put(`${JOB_PREFIX}${item.requestId}`, storedJob);
      await this.persistRunningSafely(item.requestId);
      if (isTerminal(storedJob.status)) {
        await this.finishTerminalJob(item.requestId, storedJob);
      } else {
        await this.scheduleQueueProcessing(POLL_INTERVAL_MS);
      }
    } catch (error) {
      console.error("report runner queued start failed", { errorName: error instanceof Error ? error.name : "unknown" });
      await this.retryQueuedJob(queueKey, item, error);
    }
  }

  private async processActiveJob(active: ActiveJob): Promise<void> {
    const requestId = active.requestId;
    const queueKey = `${QUEUE_PREFIX}${requestId}`;
    const item = await this.durableState.storage.get<QueueItem>(queueKey);
    const storedJob = await this.durableState.storage.get<RunnerJob>(`${JOB_PREFIX}${requestId}`);
    if (!item) {
      if (storedJob && isTerminal(storedJob.status)) {
        await this.durableState.storage.delete(ACTIVE_JOB_KEY);
        await this.scheduleQueueProcessing(0);
      } else {
        await this.failJob(requestId, "報表工作佇列資料遺失，請重新提交報表。");
      }
      return;
    }
    if (storedJob && isTerminal(storedJob.status)) {
      await this.finishTerminalJob(requestId, storedJob);
      return;
    }

    const startedAt = Number.isFinite(active.startedAt) ? active.startedAt : item.queuedAt;
    if (Date.now() - startedAt >= MAX_ACTIVE_JOB_MS) {
      await this.destroy();
      await this.failJob(requestId, "報表執行超過 60 分鐘，已停止；請查看摘要、分批或重新提交。");
      return;
    }

    if (active.phase === "starting") {
      await this.startQueuedJob(queueKey, item, active);
      return;
    }

    try {
      await this.startAndWaitForPorts();
      const response = await this.containerFetch(new Request(`http://report-runner/jobs/${requestId}`, {
        headers: { Authorization: `Bearer ${this.env.REPORT_RUNNER_TOKEN ?? ""}` },
      }));
      if (response.status === 404) {
        await this.failJob(requestId, "報表執行環境重新啟動，工作狀態遺失；請重新提交報表。");
        return;
      }
      if (!response.ok) throw new Error(`報表 Container 狀態查詢失敗（HTTP ${response.status}）。`);

      const job = await response.json() as RunnerJob;
      const stored = { ...job, requestId, updatedAtMs: Date.now() };
      await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, stored);
      if (isTerminal(stored.status)) {
        await this.finishTerminalJob(requestId, stored);
      } else {
        await this.persistRunningSafely(requestId);
        await this.durableState.storage.put(ACTIVE_JOB_KEY, { ...active, attempts: 0 });
        await this.scheduleQueueProcessing(POLL_INTERVAL_MS);
      }
    } catch (error) {
      const attempts = active.attempts + 1;
      console.error("report runner active poll failed", { attempts, errorName: error instanceof Error ? error.name : "unknown" });
      if (attempts >= MAX_ACTIVE_POLL_RETRIES) {
        await this.failJob(requestId, "報表執行狀態連線多次失敗，請重新提交報表。");
        return;
      }
      await this.durableState.storage.put(ACTIVE_JOB_KEY, { ...active, attempts });
      await this.scheduleQueueProcessing(retryDelay(attempts));
    }
  }

  private async finishTerminalJob(requestId: string, job: RunnerJob): Promise<void> {
    const stored = { ...job, requestId, updatedAtMs: Date.now() };
    await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, stored);
    if (stored.status === "failed") await this.cleanupQueuedSource(requestId);
    try {
      await this.persistTerminal(requestId, stored);
    } catch (error) {
      const active = await this.durableState.storage.get<ActiveJob>(ACTIVE_JOB_KEY);
      console.error("report runner terminal persistence failed", { errorName: error instanceof Error ? error.name : "unknown" });
      await this.durableState.storage.put(ACTIVE_JOB_KEY, {
        requestId,
        phase: "running",
        attempts: (active?.attempts ?? 0) + 1,
        startedAt: active?.startedAt ?? Date.now(),
      } satisfies ActiveJob);
      await this.scheduleQueueProcessing(retryDelay((active?.attempts ?? 0) + 1));
      return;
    }
    await this.durableState.storage.delete(`${QUEUE_PREFIX}${requestId}`);
    await this.durableState.storage.delete(ACTIVE_JOB_KEY);
    await this.scheduleQueueProcessing(0);
  }

  private async failJob(requestId: string, message: string): Promise<void> {
    const failed: RunnerJob = {
      ...(await this.durableState.storage.get<RunnerJob>(`${JOB_PREFIX}${requestId}`)),
      requestId,
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
    };
    await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, failed);
    await this.finishTerminalJob(requestId, failed);
  }

  private async cleanupQueuedSource(requestId: string): Promise<void> {
    const item = await this.durableState.storage.get<QueueItem>(`${QUEUE_PREFIX}${requestId}`);
    const sourceUrlValue = item?.payload.sourceUrl;
    if (!this.env.UPLOADS || typeof sourceUrlValue !== "string") return;
    try {
      const sourceUrl = new URL(sourceUrlValue);
      const sourceId = /^\/api\/internal\/shopee-sales\/source\/([A-Za-z0-9-]{16,80})$/.exec(sourceUrl.pathname)?.[1];
      const token = sourceUrl.searchParams.get("token") ?? "";
      if (sourceId === requestId && /^[A-Za-z0-9-]{16,80}$/.test(token)) {
        await this.env.UPLOADS.delete(`shopee-sales/${sourceId}/${token}.xlsx`);
      }
    } catch (error) {
      console.warn("report runner source cleanup failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  private async retryQueuedJob(queueKey: string, item: QueueItem, error: unknown): Promise<void> {
    const attempts = item.attempts + 1;
    const retryAt = Date.now() + retryDelay(attempts);
    if (retryAt - item.queuedAt >= MAX_QUEUE_AGE_MS) {
      await this.durableState.storage.delete(ACTIVE_JOB_KEY);
      await this.failJob(item.requestId, "報表排隊超過 24 小時，請重新提交報表。");
      return;
    }
    await this.durableState.storage.put(queueKey, { ...item, attempts, retryAt });
    await this.durableState.storage.put(`${JOB_PREFIX}${item.requestId}`, {
      requestId: item.requestId,
      status: "queued",
      error: "",
      queuedAt: item.queuedAt,
      updatedAtMs: Date.now(),
    } satisfies RunnerJob);
    await this.durableState.storage.delete(ACTIVE_JOB_KEY);
    console.warn("report runner capacity/start retry scheduled", {
      attempts,
      retryAt,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    await this.scheduleQueueProcessing(retryDelay(attempts));
  }

  private async scheduleQueueProcessing(delayMs: number): Promise<void> {
    this.deleteSchedules(QUEUE_CALLBACK);
    await this.schedule(new Date(Date.now() + Math.max(0, delayMs)), QUEUE_CALLBACK);
  }

  private async persistRunningSafely(requestId: string): Promise<void> {
    if (!this.env.DB) return;
    try {
      await updateReportRun(createDatabase(this.env.DB), { requestId, status: "running" });
    } catch (error) {
      console.error("report runner running status persistence failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  private async persistTerminal(requestId: string, job: RunnerJob): Promise<void> {
    if (!this.env.DB) return;
    const result = job.result as { salesRows?: number; payoutRows?: number } | null;
    await updateReportRun(createDatabase(this.env.DB), {
      requestId,
      status: job.status === "succeeded" ? "succeeded" : "failed",
      lastError: typeof job.error === "string" ? job.error : "",
      importedSalesRows: result?.salesRows,
      importedPayoutRows: result?.payoutRows,
    });
  }

  private async pruneTerminalJobs(): Promise<void> {
    const entries = await this.durableState.storage.list<RunnerJob>({ prefix: JOB_PREFIX });
    const terminal = [...entries.entries()]
      .filter(([, job]) => isTerminal(job.status))
      .sort((left, right) => (left[1].updatedAtMs ?? 0) - (right[1].updatedAtMs ?? 0));
    const removeCount = Math.max(0, terminal.length - 99);
    for (const [key] of terminal.slice(0, removeCount)) {
      await this.durableState.storage.delete(key);
    }
  }

  private async fetchLegacy(request: Request, pathname: string): Promise<Response> {
    const submitted = request.method === "POST"
      ? await request.clone().json().catch(() => null) as { requestId?: string } | null
      : null;
    const jobId = /^\/jobs\/([A-Za-z0-9-]{16,80})$/.exec(pathname)?.[1]
      ?? (submitted?.requestId && /^[A-Za-z0-9-]{16,80}$/.test(submitted.requestId) ? submitted.requestId : undefined);
    const saved = jobId ? await this.durableState.storage.get<RunnerJob>(`${JOB_PREFIX}${jobId}`) : undefined;
    if (request.method === "GET" && jobId && !saved) return Response.json({ error: "job_not_found" }, { status: 404 });
    if (request.method === "GET" && saved && isTerminal(saved.status)) return Response.json(saved);
    if (request.method === "POST" && saved) return Response.json(saved, { status: 202 });

    await this.startAndWaitForPorts();
    const headers = new Headers(request.headers);
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
    const response = await this.containerFetch(new Request(`http://report-runner${pathname}${new URL(request.url).search}`, {
      method: request.method,
      headers,
      body,
    }));
    if (response.ok && jobId) {
      const job = await response.clone().json() as RunnerJob;
      if (isTerminal(job.status)) {
        await this.persistTerminal(jobId, job);
        await this.durableState.storage.put(`${JOB_PREFIX}${jobId}`, job);
      } else {
        await this.durableState.storage.put(`${JOB_PREFIX}${jobId}`, job);
        await this.durableState.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
        if (saved?.status !== "running") await this.persistRunningSafely(jobId);
      }
    }
    return response;
  }

  private async pollLegacyJob(): Promise<void> {
    const entries = await this.durableState.storage.list<RunnerJob>({ prefix: JOB_PREFIX });
    const [jobKey, job] = [...entries.entries()].find(([, value]) => !isTerminal(value.status)) ?? [];
    if (!jobKey || !job) return;
    const requestId = job.requestId ?? jobKey.slice(JOB_PREFIX.length);
    try {
      await this.startAndWaitForPorts();
      const response = await this.containerFetch(new Request(`http://report-runner/jobs/${requestId}`, {
        headers: { Authorization: `Bearer ${this.env.REPORT_RUNNER_TOKEN ?? ""}` },
      }));
      if (response.ok) {
        const current = await response.json() as RunnerJob;
        if (isTerminal(current.status)) {
          await this.persistTerminal(requestId, current);
          await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, current);
          return;
        }
        await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, current);
      } else if (response.status === 404) {
        await this.persistTerminal(requestId, {
          ...job,
          status: "failed",
          error: "報表執行環境重新啟動，工作狀態遺失。",
          finishedAt: new Date().toISOString(),
        });
        await this.durableState.storage.put(`${JOB_PREFIX}${requestId}`, {
          ...job,
          status: "failed",
          error: "報表執行環境重新啟動，工作狀態遺失。",
          finishedAt: new Date().toISOString(),
        });
        return;
      }
    } catch (error) {
      console.error("report runner legacy status poll failed", { errorName: error instanceof Error ? error.name : "unknown" });
    }
    await this.durableState.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 10_000 * 2 ** Math.max(0, attempt - 1));
}
