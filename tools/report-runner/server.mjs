import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processShopeeWorkbook, previewFromSummary } from "../shopee-sales-report-export/driver.mjs";
import { loadConfig } from "../shopee-sales-report-export/lib/common.mjs";
import { appendTail, cyberbizFailureMessage, safeErrorMessage } from "./diagnostics.mjs";
import { cyberbizLoginProbeValidationReason } from "./request-validation.mjs";

const PORT = 8080;
const MAX_BODY_BYTES = 1_000_000;
const MAX_STORES = 20;
const MAX_CYBERBIZ_JOB_RUNTIME_MS = 55 * 60_000;
const CHILD_TERMINATION_GRACE_MS = 10_000;
const MAX_CHILD_STDERR_CHARS = 16_000;
const MAX_CHILD_STDOUT_ERROR_CHARS = 2_000;
const jobs = new Map();

function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validCyberbizRequest(value) {
  return ["cyberbiz-payout", "cyberbiz-sales"].includes(value.kind)
    && value.credentials && typeof value.credentials === "object"
    && typeof value.credentials.cyberbizUsername === "string"
    && typeof value.credentials.cyberbizPassword === "string"
    && typeof value.credentials.gmailRefreshToken === "string"
    && typeof value.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.start)
    && typeof value.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.end)
    && value.start <= value.end
    && Array.isArray(value.stores) && value.stores.length > 0 && value.stores.length <= MAX_STORES
    && value.stores.every((store) => store && typeof store === "object"
      && typeof store.name === "string" && store.name.trim().length > 0
      && typeof store.scopeId === "string" && store.scopeId.trim().length > 0
      && typeof store.driveFolderUrl === "string"
      && typeof store.driveFolderName === "string");
}

function validCyberbizLoginProbeRequest(value) {
  return cyberbizLoginProbeValidationReason(value) === null;
}

function validRequest(value) {
  if (!value || typeof value !== "object"
    || typeof value.requestId !== "string" || !/^[A-Za-z0-9-]{16,80}$/.test(value.requestId)) return false;
  if (value.kind === "cyberbiz-payout" || value.kind === "cyberbiz-sales") return validCyberbizRequest(value);
  if (value.kind === "cyberbiz-login-probe") return validCyberbizLoginProbeRequest(value);
  return typeof value.sourceUrl === "string" && value.sourceUrl.startsWith("https://")
    && typeof value.start === "string" && typeof value.end === "string"
    && typeof value.scopeId === "string" && typeof value.scopeName === "string"
    && typeof value.driveFolderUrl === "string";
}

async function downloadSource(sourceUrl) {
  try {
    const response = await fetch(sourceUrl, { redirect: "error" });
    if (!response.ok) throw new Error(`無法讀取暫存報表（HTTP ${response.status}）。`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("報表超過 25 MB。 ");
    const password = Buffer.from(response.headers.get("x-shopee-report-password") ?? "", "base64").toString("utf8");
    const filename = Buffer.from(response.headers.get("x-shopee-report-filename") ?? "", "base64").toString("utf8");
    if (!password || !/\.xlsx$/iu.test(filename)) throw new Error("暫存報表缺少必要的解密資訊。 ");
    return { bytes: Buffer.from(bytes), password, filename: path.basename(filename) };
  } finally {
    const cleanupUrl = sourceUrl.replace("/source/", "/cleanup/");
    await fetch(cleanupUrl, { method: "POST" }).catch(() => undefined);
  }
}

async function processWorkbook(payload, { previewOnly = false } = {}) {
  const source = await downloadSource(payload.sourceUrl);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "report-run-"));
  try {
    const inputPath = path.join(tempDir, "source.xlsx");
    await writeFile(inputPath, source.bytes);
    const config = await loadConfig();
    const env = {
      // Driver 沿用 GitHub Actions 的通用環境名稱；Cloudflare bindings 使用報表專用名稱。
      GOOGLE_CLIENT_ID: process.env.GOOGLE_REPORTS_OAUTH_CLIENT_ID ?? "",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_REPORTS_OAUTH_CLIENT_SECRET ?? "",
      GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN ?? "",
      PLATFORM_API_URL: process.env.PLATFORM_API_URL ?? "https://platform.rueisiang.com",
      CYBERBIZ_REPORT_INGEST_TOKEN: process.env.CYBERBIZ_REPORT_INGEST_TOKEN ?? "",
    };
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
      throw new Error("報表 Container 缺少 Google Drive 憑證設定。 ");
    }
    const completeMonth = /^\d{4}-\d{2}$/.test(payload.start.slice(0, 7))
      && payload.start.endsWith("-01")
      && payload.end.startsWith(payload.start.slice(0, 7) + "-")
      && Number(payload.end.slice(-2)) === new Date(Date.UTC(Number(payload.start.slice(0, 4)), Number(payload.start.slice(5, 7)), 0)).getUTCDate();
    if (!previewOnly && completeMonth && !env.CYBERBIZ_REPORT_INGEST_TOKEN) {
      throw new Error("完整月份報表缺少 D1 匯入憑證，未執行 Drive 上傳。 ");
    }
    const result = await processShopeeWorkbook({
      inputPath,
      password: source.password,
      driveFolderUrl: payload.driveFolderUrl,
      scopeId: payload.scopeId,
      scopeName: payload.scopeName,
      start: payload.start,
      end: payload.end,
      skipUpload: previewOnly,
      config,
      env,
    });
    return previewOnly ? previewFromSummary(result.summary) : {
      outputFilename: path.basename(result.outputPath),
      driveUrl: result.uploaded?.webViewLink ?? null,
      driveFileAlreadyExisted: result.driveFileAlreadyExisted,
      ingested: Boolean(result.ingested),
      salesRows: result.ingested?.salesRowCount ?? 0,
      payoutRows: result.ingested?.payoutRowCount ?? 0,
      skippedSkus: result.ingested?.skippedSkus ?? [],
      summary: {
        totalPerformance: result.summary.totalPerformance,
        totalQuantity: result.summary.totalQuantity,
        totalSalesAmount: result.summary.totalSalesAmount,
        uniqueOrders: result.summary.uniqueOrders,
        uniqueProducts: result.summary.uniqueProducts,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function updateCyberbizProgress(job, line) {
  const store = /^──\s+(.+?)\s+──$/.exec(line)?.[1];
  if (store) {
    job.progress = `處理通路：${store}`;
    return;
  }
  const match = /^(登入 CYBERBIZ…|已登入後台。|匯出已送出，等信…|已取檔：.+|驗證通過：.+|已寫入 .+|已上傳到 .+|公式驗證通過：.+|卡住：.+)$/.exec(line.trim());
  if (match) job.progress = match[1].slice(0, 240);
}

async function runCyberbizJob(payload, job) {
  const credentials = payload.credentials;
  const required = [
    ["CYBERBIZ_USERNAME", credentials?.cyberbizUsername],
    ["CYBERBIZ_PASSWORD", credentials?.cyberbizPassword],
    ["GOOGLE_REPORTS_OAUTH_CLIENT_ID", process.env.GOOGLE_REPORTS_OAUTH_CLIENT_ID],
    ["GOOGLE_REPORTS_OAUTH_CLIENT_SECRET", process.env.GOOGLE_REPORTS_OAUTH_CLIENT_SECRET],
    ["GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN", process.env.GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN],
    ["GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN", credentials?.gmailRefreshToken],
  ];
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`報表 Container 尚未設定必要憑證：${missing.join("、")}`);

  const resultDir = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-run-"));
  const resultPath = path.join(resultDir, "result.json");
  const toolDir = "/app/tools/cyberbiz-reports";
  const driver = payload.kind === "cyberbiz-payout" ? "payout/driver.mjs" : "sales/driver.mjs";
  const args = [driver, "--headless", "--start", payload.start, "--end", payload.end];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: toolDir,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CI: "true",
        PAYOUT_BROWSER_CHANNEL: "chromium",
        REPORT_STORES_JSON: JSON.stringify(payload.stores),
        REPORT_RUNNER_RESULT_PATH: resultPath,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_REPORTS_OAUTH_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_REPORTS_OAUTH_CLIENT_SECRET,
        GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN,
        GMAIL_REFRESH_TOKEN: credentials?.gmailRefreshToken,
        CYBERBIZ_USERNAME: credentials?.cyberbizUsername,
        CYBERBIZ_PASSWORD: credentials?.cyberbizPassword,
        PLATFORM_API_URL: process.env.PLATFORM_API_URL ?? "https://platform.rueisiang.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let pending = "";
    let driverStdoutError = "";
    let childStderr = "";
    let timedOut = false;
    let spawnError;
    let forceKillTimer;
    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") child.kill(signal);
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceKillTimer = setTimeout(() => terminate("SIGKILL"), CHILD_TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    }, MAX_CYBERBIZ_JOB_RUNTIME_MS);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("執行失敗：")) {
          driverStdoutError = appendTail(driverStdoutError, line, MAX_CHILD_STDOUT_ERROR_CHARS);
        }
        updateCyberbizProgress(job, line);
      }
    });
    child.stderr.on("data", (chunk) => {
      childStderr = appendTail(childStderr, chunk, MAX_CHILD_STDERR_CHARS);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (spawnError) {
        await rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
        reject(spawnError);
        return;
      }
      try {
        let report = null;
        try { report = JSON.parse(await readFile(resultPath, "utf8")); } catch {}
        const reportMarkdown = report?.reportPath
          ? await readFile(report.reportPath, "utf8").catch(() => "")
          : "";
        const stores = Array.isArray(report?.stores) ? report.stores : [];
        const salesRows = payload.kind === "cyberbiz-sales"
          ? stores.reduce((sum, item) => sum + (["ok", "partial"].includes(item.steps?.ingest) ? Number(item.rows ?? 0) : 0), 0)
          : 0;
        const payoutRows = payload.kind === "cyberbiz-payout"
          ? stores.reduce((sum, item) => sum + (["ok", "partial"].includes(item.steps?.ingest) ? Number(item.rows ?? 0) : 0), 0)
          : 0;
        job.result = {
          reportKind: payload.kind,
          stores,
          reportMarkdown,
          salesRows,
          payoutRows,
        };
        const errors = stores.filter((item) => !item.done && item.error?.message)
          .map((item) => `${item.store}：${safeErrorMessage(new Error(item.error.message), credentials)}`);
        const failureCode = typeof report?.failure?.code === "string"
          && /^[A-Z][A-Z0-9_]{0,63}$/.test(report.failure.code)
          ? `[${report.failure.code}] `
          : "";
        const driverFailure = typeof report?.failure?.message === "string"
          ? `${failureCode}${safeErrorMessage(new Error(report.failure.message), credentials)}`
          : "";
        const stdoutFailure = driverStdoutError
          ? safeErrorMessage(new Error(driverStdoutError), credentials)
          : "";
        const stderrFailure = childStderr.trim()
          ? safeErrorMessage(new Error(childStderr.trim()), credentials)
          : "";
        if (!timedOut && code === 0) {
          job.status = "succeeded";
          job.error = "";
        } else {
          job.status = "failed";
          job.error = timedOut
            ? "CYBERBIZ 報表執行超過 55 分鐘，已停止；請查看摘要、分批或重新提交。"
            : cyberbizFailureMessage({ errors, driverFailure, stdoutFailure, stderrFailure });
        }
        job.finishedAt = new Date().toISOString();
        resolve(job);
      } catch (error) {
        reject(error);
      } finally {
        await rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });
}

async function runCyberbizLoginProbe(payload, job) {
  const credentials = payload.credentials;
  const child = spawn("python3", ["/app/tools/cyberbiz-reports/scrapling_login_probe.py"], {
    cwd: "/app/tools/cyberbiz-reports",
    env: {
      ...process.env,
      CYBERBIZ_USERNAME: credentials.cyberbizUsername,
      CYBERBIZ_PASSWORD: credentials.cyberbizPassword,
      CYBERBIZ_LOGIN_PROBE_STORE: payload.storeName,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  let stdout = "";
  let timedOut = false;
  let spawnError;
  let forceKillTimer;
  const terminate = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") child.kill(signal);
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    forceKillTimer = setTimeout(() => terminate("SIGKILL"), CHILD_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  }, 120_000);
  timeout.unref();
  child.stdout.on("data", (chunk) => {
    stdout = appendTail(stdout, chunk, 4_000);
  });
  return new Promise((resolve) => {
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      let probe = null;
      for (const line of stdout.trim().split(/\r?\n/).reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.store === payload.storeName && typeof parsed.outcome === "string") {
            probe = parsed;
            break;
          }
        } catch {}
      }
      const outcome = typeof probe?.outcome === "string" ? probe.outcome : "probe_failed";
      const challengeResolutionConfirmed = probe?.challengeResolutionConfirmed === true;
      const probeErrorType = typeof probe?.errorType === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(probe.errorType)
        ? probe.errorType
        : null;
      const loginReached = ["two_factor_required", "target_store_visible", "signed_in"].includes(outcome);
      const successful = !timedOut && !spawnError && code === 0 && loginReached && challengeResolutionConfirmed;
      const labels = {
        two_factor_required: "已到達 2FA",
        target_store_visible: "已登入並找到測試店",
        signed_in: "已登入，未確認測試店連結",
        challenge_not_cleared: "載入後仍停在 Cloudflare challenge",
        cloudflare_challenge: "帳密送出後仍停在 Cloudflare challenge",
        challenge_after_submit: "帳密送出後仍停在 Cloudflare challenge",
        login_form: "送出後仍停在登入表單",
        login_form_remaining: "送出後仍停在登入表單",
        missing_credentials: "Runner 缺少登入憑證",
        unsupported_test_store: "不允許的測試店別",
        automation_error: "登入操作發生錯誤",
        fetcher_error: probeErrorType
          ? `Scrapling 瀏覽器執行失敗（${probeErrorType}）`
          : "Scrapling 瀏覽器執行失敗",
        invalid_runner_config: "CYBERBIZ 網址設定無效",
        unexpected_login_form: "登入欄位與預期不同",
        unknown: "無法分類登入結果",
        probe_failed: "無法取得登入探測結果",
      };
      const outcomeLabel = loginReached
        ? challengeResolutionConfirmed
          ? `${labels[outcome]}；觀察到 Turnstile 解題回應`
          : `${labels[outcome]}，但未觀察到解題回應，無法確認 solver 成功`
        : labels[outcome] ?? "登入結果未知";
      const summary = `登入測試（${payload.storeName}）：${outcomeLabel}。未執行報表匯出或寫入。`;
      job.result = {
        probeOutcome: outcome,
        challengeResolutionConfirmed,
        probeSummary: summary,
        ...(probeErrorType ? { probeErrorType } : {}),
      };
      if (successful) {
        job.status = "succeeded";
        job.error = "";
      } else {
        job.status = "failed";
        job.error = timedOut
          ? "CYBERBIZ 登入測試逾時；未執行報表匯出或寫入。"
          : summary;
      }
      job.finishedAt = new Date().toISOString();
      resolve(job);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
  });
}

async function processJob(payload, job, { previewOnly = false } = {}) {
  if (payload.kind === "cyberbiz-login-probe") return runCyberbizLoginProbe(payload, job);
  if (payload.kind === "cyberbiz-payout" || payload.kind === "cyberbiz-sales") {
    return runCyberbizJob(payload, job);
  }
  const result = await processWorkbook(payload, { previewOnly });
  job.status = "succeeded";
  job.result = result;
  job.finishedAt = new Date().toISOString();
  return job;
}

async function runJob(payload, { previewOnly = false } = {}) {
  const existing = jobs.get(payload.requestId);
  if (existing) return existing;
  const job = {
    requestId: payload.requestId,
    status: "running",
    startedAt: new Date().toISOString(),
    result: null,
    error: "",
    progress: payload.kind === "cyberbiz-login-probe"
      ? "執行 CYBERBIZ 登入測試…"
      : payload.kind?.startsWith("cyberbiz-") ? "啟動 CYBERBIZ 報表…" : "",
  };
  jobs.set(payload.requestId, job);
  void processJob(payload, job, { previewOnly }).catch((error) => {
    job.status = "failed";
    job.error = safeErrorMessage(error, payload.credentials);
    job.finishedAt = new Date().toISOString();
    console.error(JSON.stringify({ event: "report_runner.job_failed", errorName: error instanceof Error ? error.name : "unknown" }));
  });
  return job;
}

const server = createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") return send(response, 200, { ok: true });
  if (request.headers.authorization !== `Bearer ${process.env.REPORT_RUNNER_TOKEN ?? ""}` || !process.env.REPORT_RUNNER_TOKEN) {
    return send(response, 401, { error: "unauthorized" });
  }
  try {
    if (request.url === "/preview" && request.method === "POST") {
      const payload = await readJson(request);
      if (!validRequest(payload) || payload.kind) return send(response, 400, { error: "invalid_request" });
      return send(response, 202, await runJob(payload, { previewOnly: true }));
    }
    if (request.url === "/jobs" && request.method === "POST") {
      const payload = await readJson(request);
      if (!validRequest(payload)) {
        const reason = payload?.kind === "cyberbiz-login-probe"
          ? cyberbizLoginProbeValidationReason(payload)
          : null;
        return send(response, 400, { error: "invalid_request", ...(reason ? { reason } : {}) });
      }
      return send(response, 202, await runJob(payload));
    }
    const match = /^\/jobs\/([A-Za-z0-9-]{16,80})$/.exec(request.url ?? "");
    if (match && request.method === "GET") {
      const job = jobs.get(match[1]);
      return job ? send(response, 200, job) : send(response, 404, { error: "job_not_found" });
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(JSON.stringify({ event: "report_runner.request_failed", errorName: error instanceof Error ? error.name : "unknown" }));
    return send(response, 500, { error: safeErrorMessage(error) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`report runner listening on ${PORT}`));
