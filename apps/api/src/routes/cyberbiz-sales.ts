import { listCyberbizReportRuns, listPayoutStores, recordCyberbizReportRun, updateReportRun } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/auth.js";
import { body } from "../request.js";
import { cyberbizSalesGithub } from "../cyberbiz-sales/github.js";
import { runnerStores } from "../cyberbiz-scope.js";
import {
  containerJobStatus,
  containerLoginProbeConfigured,
  containerRunnerConfigured,
  cyberbizRunnerConfigured,
  isContainerRequestId,
  newContainerRequestId,
  readContainerJob,
  submitContainerJob,
  usesContainerRunner,
} from "../report-runner.js";

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function previousMonthRange(): { start: string; end: string } {
  const taipei = new Date(Date.now() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth();
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  const padded = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${padded}-01`, end: `${year}-${padded}-${lastDay}` };
}

function periodKind(start: string, end: string): "month" | "custom" {
  const [year, month] = start.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return start === `${year}-${String(month).padStart(2, "0")}-01`
    && end === `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
    ? "month"
    : "custom";
}

function selectedStores(input: Record<string, unknown>, known: string[]): string[] {
  const requested = Array.isArray(input.stores) ? input.stores.map(String) : [];
  if (!requested.length) throw new HTTPException(400, { message: "沒有選到任何店別。" });
  if (new Set(requested).size !== requested.length) throw new HTTPException(400, { message: "店別不能重複。" });
  const unknown = requested.filter((name) => !known.includes(name));
  if (unknown.length) throw new HTTPException(400, { message: `不認得的通路：${unknown.join("、")}` });
  return requested;
}

export const cyberbizSales = new Hono<AppEnv>()
  .get("/state", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    const stores = await listPayoutStores(c.get("db"), { enabledOnly: true });
    const runs = await listCyberbizReportRuns(c.get("db"), "sales", 10);
    const range = previousMonthRange();
    return c.json({
      stores: stores.map((store) => ({ name: store.name, scopeId: store.id, folder: store.driveFolderName, folderUrl: store.driveFolderUrl })),
      defaultStart: range.start,
      defaultEnd: range.end,
      configured: cyberbizRunnerConfigured(c.env, Boolean(cyberbizSalesGithub(c.env))),
      runnerMode: usesContainerRunner(c.env) ? "container" : "github",
      latestRequestId: runs.find((run) => isContainerRequestId(run.requestId) === usesContainerRunner(c.env))?.requestId ?? null,
      runs,
    });
  })
  .post("/login-probe", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    if (!usesContainerRunner(c.env) || !containerLoginProbeConfigured(c.env)) {
      throw new HTTPException(503, { message: "登入測試僅能在已設定 CYBERBIZ 憑證的 Container Runner 執行。" });
    }
    const testStore = (await listPayoutStores(c.get("db"), { enabledOnly: true }))
      .find((store) => store.name === "中和環球");
    if (!testStore) throw new HTTPException(404, { message: "找不到啟用中的測試店別「中和環球」。" });
    const requestId = newContainerRequestId();
    const job = await submitContainerJob(c.env, {
      kind: "cyberbiz-login-probe",
      requestId,
      storeName: testStore.name,
    });
    return c.json({ requestId, job, store: testStore.name }, 202);
  })
  .post("/run", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    const github = cyberbizSalesGithub(c.env);
    const containerMode = usesContainerRunner(c.env);
    if (containerMode ? !containerRunnerConfigured(c.env) : !github) {
      throw new HTTPException(503, { message: containerMode
        ? "報表 Container 或 CYBERBIZ／Google 報表憑證尚未設定，無法觸發執行。"
        : "平台還沒設定商品銷售報表的 GitHub workflow，無法觸發執行。" });
    }
    const input = await body(c);
    const configuredStores = await listPayoutStores(c.get("db"));
    const known = configuredStores.filter((store) => store.enabled).map((store) => store.name);
    const stores = selectedStores(input, known);
    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    if (!isValidDate(start) || !isValidDate(end)) {
      throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
    }
    if (start > end) throw new HTTPException(400, { message: "起日不能晚於迄日。" });

    const all = stores.length === known.length && known.every((name) => stores.includes(name));
    const store = all && stores.length === configuredStores.length
      ? "全部"
      : stores.length === 1
        ? stores[0]!
        : JSON.stringify(stores);
    const runnerStoreList = runnerStores(configuredStores.filter((item) => stores.includes(item.name)));
    const requestId = containerMode ? newContainerRequestId() : crypto.randomUUID();
    const runInput = {
      requestId,
      reportKind: "sales" as const,
      periodKind: periodKind(start, end),
      stores,
      scopeIds: configuredStores.filter((store) => stores.includes(store.name)).map((store) => store.id),
      startDate: start,
      endDate: end,
      actor: c.get("user"),
    };
    let run;
    if (containerMode) {
      // Container 可能在 HTTP response 後立即開始執行；先寫 run row，避免它的狀態更新搶在 insert 前。
      run = await recordCyberbizReportRun(c.get("db"), runInput);
      try {
        await submitContainerJob(c.env, { kind: "cyberbiz-sales", requestId, stores: runnerStoreList, start, end });
      } catch (error) {
        await updateReportRun(c.get("db"), { requestId, status: "failed", lastError: "報表 Container 無法接受工作。" });
        throw error;
      }
    } else {
      await github!.dispatch({ store, stores: runnerStoreList, start, end, requestId });
      run = await recordCyberbizReportRun(c.get("db"), runInput);
    }
    return c.json({ requestId, run, store, start, end }, 202);
  })
  .get("/status", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    const requestId = c.req.query("requestId") ?? undefined;
    if (requestId && isContainerRequestId(requestId)) {
      return c.json(containerJobStatus(await readContainerJob(c.env, requestId), requestId));
    }
    const github = cyberbizSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GitHub workflow。" });
    return c.json(await github.listRuns(requestId));
  });
