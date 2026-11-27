import type { Env } from "./env.js";

const SHARED_MODE_HEADER = "x-report-runner-mode";
const CONTAINER_REQUEST_PREFIX = "cf-";

export interface CyberbizRunnerStore {
  scopeId: string;
  name: string;
  driveFolderUrl: string;
  driveFolderName: string;
}

export type CyberbizRunnerPayload =
  | {
    kind: "cyberbiz-payout" | "cyberbiz-sales";
    requestId: string;
    start: string;
    end: string;
    stores: CyberbizRunnerStore[];
  }
  | {
    kind: "cyberbiz-login-probe";
    requestId: string;
    storeName: string;
  };

export interface ReportRunnerJob {
  requestId: string;
  status: string;
  error?: string;
  progress?: string;
  result?: {
    stores?: Array<{
      store: string;
      done: boolean;
      steps?: Record<string, string>;
      error?: { code?: string; message?: string };
    }>;
    salesRows?: number;
    payoutRows?: number;
    reportMarkdown?: string;
    probeOutcome?: string;
    probeSummary?: string;
  } | null;
}

export function usesContainerRunner(env: Env): boolean {
  return env.CYBERBIZ_REPORT_RUNNER_MODE === "container";
}

export function containerLoginProbeConfigured(env: Env): boolean {
  return Boolean(env.REPORT_RUNNER && env.REPORT_RUNNER_TOKEN && env.CYBERBIZ_USERNAME && env.CYBERBIZ_PASSWORD);
}

export function containerRunnerConfigured(env: Env): boolean {
  return Boolean(
    env.REPORT_RUNNER
    && env.REPORT_RUNNER_TOKEN
    && env.CYBERBIZ_USERNAME
    && env.CYBERBIZ_PASSWORD
    && env.GOOGLE_REPORTS_OAUTH_CLIENT_ID
    && env.GOOGLE_REPORTS_OAUTH_CLIENT_SECRET
    && env.GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN
    && env.GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN,
  );
}

export function cyberbizRunnerConfigured(env: Env, githubConfigured: boolean): boolean {
  return usesContainerRunner(env) ? containerRunnerConfigured(env) : githubConfigured;
}

export function newContainerRequestId(): string {
  return `${CONTAINER_REQUEST_PREFIX}${crypto.randomUUID()}`;
}

export function isContainerRequestId(requestId: string): boolean {
  return requestId.startsWith(CONTAINER_REQUEST_PREFIX);
}

function runnerStub(env: Env): DurableObjectStub | null {
  if (!env.REPORT_RUNNER || !env.REPORT_RUNNER_TOKEN) return null;
  return env.REPORT_RUNNER.get(env.REPORT_RUNNER.idFromName("shared"));
}

export async function submitContainerJob(env: Env, payload: CyberbizRunnerPayload): Promise<ReportRunnerJob> {
  const stub = runnerStub(env);
  if (!stub) throw new Error("報表 Container 尚未設定，請聯絡管理者。");
  const response = await stub.fetch("https://report-runner/jobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REPORT_RUNNER_TOKEN}`,
      "Content-Type": "application/json",
      [SHARED_MODE_HEADER]: "shared",
    },
    body: JSON.stringify(payload),
  });
  const job = await response.json().catch(() => null) as ReportRunnerJob | null;
  if (!response.ok || !job) {
    throw new Error(typeof job?.error === "string" ? job.error : `報表 Container 無法接受工作（HTTP ${response.status}）。`);
  }
  return job;
}

export async function readContainerJob(env: Env, requestId: string): Promise<ReportRunnerJob | null> {
  const stub = runnerStub(env);
  if (!stub) throw new Error("報表 Container 尚未設定，請聯絡管理者。");
  const response = await stub.fetch(`https://report-runner/jobs/${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${env.REPORT_RUNNER_TOKEN}` },
  });
  if (response.status === 404) return null;
  const job = await response.json().catch(() => null) as ReportRunnerJob | null;
  if (!response.ok || !job) throw new Error(`報表 Container 狀態查詢失敗（HTTP ${response.status}）。`);
  return job;
}

const STEP_LABELS: Record<string, string> = {
  export: "匯出",
  fetch: "取檔",
  verify: "驗證",
  columns: "加欄位",
  upload: "上傳 Drive",
  ingest: "匯入 D1",
};

export function containerJobStatus(job: ReportRunnerJob | null, requestId = ""): {
  runs: Array<{ id: number; status: string; conclusion: string | null; title: string; error?: string; reportMarkdown?: string }>;
  steps: Array<{ name: string; status: string; conclusion: string | null }>;
} {
  if (!job) return requestId
    ? {
      runs: [{ id: 0, status: "completed", conclusion: "failure", title: requestId, error: "找不到這次報表的執行狀態，請重新提交。" }],
      steps: [],
    }
    : { runs: [], steps: [] };
  const terminal = job.status === "succeeded" || job.status === "failed";
  const conclusion = job.status === "succeeded" ? "success" : job.status === "failed" ? "failure" : null;
  const steps = (job.result?.stores ?? []).flatMap((store) => Object.entries(store.steps ?? {}).map(([key, value]) => ({
    name: `${store.store}・${STEP_LABELS[key] ?? key}`,
    status: value === "skip" ? "skipped" : value === "fail" || value === "partial" || value === "ok" ? "completed" : "in_progress",
    conclusion: value === "fail" || value === "partial" ? "failure" : value === "ok" ? "success" : value === "skip" ? "skipped" : null,
  })));
  if (!terminal && job.progress) steps.push({ name: job.progress, status: "in_progress", conclusion: null });
  return {
    runs: [{
      id: 0,
      status: terminal ? "completed" : job.status === "queued" ? "queued" : "in_progress",
      conclusion,
      title: job.requestId,
      ...(typeof job.error === "string" && job.error ? { error: job.error } : {}),
      ...(typeof job.result?.reportMarkdown === "string" && job.result.reportMarkdown
        ? { reportMarkdown: job.result.reportMarkdown }
        : typeof job.result?.probeSummary === "string" && job.result.probeSummary
          ? { reportMarkdown: job.result.probeSummary }
          : {}),
    }],
    steps,
  };
}
