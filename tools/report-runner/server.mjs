import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processShopeeWorkbook, previewFromSummary } from "../shopee-sales-report-export/driver.mjs";
import { loadConfig } from "../shopee-sales-report-export/lib/common.mjs";

const PORT = 8080;
const MAX_BODY_BYTES = 1_000_000;
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

function validRequest(value) {
  return value && typeof value === "object"
    && typeof value.requestId === "string" && /^[A-Za-z0-9-]{16,80}$/.test(value.requestId)
    && typeof value.sourceUrl === "string" && value.sourceUrl.startsWith("https://")
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
      // Driver 仍沿用 GitHub Actions 的通用環境名稱；Cloudflare bindings 使用報表專用名稱。
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

async function runJob(payload, { previewOnly = false } = {}) {
  const existing = jobs.get(payload.requestId);
  if (existing) return existing;
  const job = { requestId: payload.requestId, status: "running", startedAt: new Date().toISOString(), result: null, error: "" };
  jobs.set(payload.requestId, job);
  void processWorkbook(payload, { previewOnly }).then((result) => {
    job.status = "succeeded";
    job.result = result;
    job.finishedAt = new Date().toISOString();
  }).catch((error) => {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "報表處理失敗。";
    job.finishedAt = new Date().toISOString();
    console.error(JSON.stringify({ event: "report_runner.job_failed", requestId: payload.requestId, error: job.error }));
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
      if (!validRequest(payload)) return send(response, 400, { error: "invalid_request" });
      return send(response, 202, await runJob(payload, { previewOnly: true }));
    }
    if (request.url === "/jobs" && request.method === "POST") {
      const payload = await readJson(request);
      if (!validRequest(payload)) return send(response, 400, { error: "invalid_request" });
      return send(response, 202, await runJob(payload));
    }
    const match = /^\/jobs\/([A-Za-z0-9-]{16,80})$/.exec(request.url ?? "");
    if (match && request.method === "GET") {
      const job = jobs.get(match[1]);
      return job ? send(response, 200, job) : send(response, 404, { error: "job_not_found" });
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(JSON.stringify({ event: "report_runner.request_failed", error: error instanceof Error ? error.message : String(error) }));
    return send(response, 500, { error: error instanceof Error ? error.message : "報表處理失敗。" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`report runner listening on ${PORT}`));
