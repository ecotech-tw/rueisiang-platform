import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { vi } from "vitest";
import { createDatabase, createReportManagementScope, getShopeeSalesSettings, listShopeeSalesRuns, syncSystemRoles } from "@rueisiang/db";
import { reportRunScopes, reportRuns, rolePermissionGrants, roles, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "test-secret";
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

function stubRunner() {
  const jobs = new Map<string, Record<string, unknown>>();
  const calls = Object.assign([] as { url: string; body: Record<string, unknown> }[], {
    runnerNames: [] as string[],
    runnerModes: [] as (string | null)[],
    jobs,
  });
  const preview = {
    reportMonths: ["2025-02"], dailyPayoutRows: [{ businessDate: "2025-02-14", payoutAmount: 280 }], sourceRowCount: 3, rowCount: 1,
    rows: [{ reportMonth: "2025-02", sku: "SKU-1", productName: "商品一", grossQuantity: 3, returnQuantity: 0, netQuantity: 3, salesAmount: 300 }],
    uniqueOrders: 2, uniqueProducts: 1, totalPerformance: 280, totalQuantity: 3, totalSalesAmount: 300,
    duplicateRowsExcluded: 1, warnings: [],
  };
  env.REPORT_RUNNER = { getByName: (name: string) => {
    calls.runnerNames.push(name);
    return { fetch: async (request: Request) => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
    calls.runnerModes.push(request.headers.get("X-Report-Runner-Mode"));
    calls.push({ url: `${url.pathname}${url.search}`, body });
    if (url.pathname === "/preview" || url.pathname === "/jobs") {
      const requestId = String(body.requestId);
      jobs.set(requestId, { requestId, status: "succeeded", result: url.pathname === "/preview" ? preview : {
        driveUrl: "https://drive.google.com/file/d/file-id/view", driveFileAlreadyExisted: false, ingested: true, salesRows: 1, payoutRows: 1,
      }, error: "" });
      return Response.json(jobs.get(requestId), { status: 202 });
    }
    const requestId = url.pathname.split("/").at(-1) ?? "";
    const job = jobs.get(requestId);
    return job ? Response.json(job) : Response.json({ error: "job_not_found" }, { status: 404 });
  } };
  } };
  return calls;
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, requestPath: string, init: RequestInit = {}) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }), SECRET);
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}`);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return app.fetch(new Request(`https://platform.rueisiang.com${requestPath}`, { ...init, headers }), env as never);
}

beforeEach(async () => {
  d1 = createLocalD1();
  uploads = createLocalR2(fs.mkdtempSync(path.join(os.tmpdir(), "shopee-sales-test-")));
  env = {
    DB: d1,
    UPLOADS: uploads,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    REPORT_RUNNER_TOKEN: "runner-token",
    SHOPEE_SOURCE_BASE_URL: "https://platform.rueisiang.com",
  };
  stubRunner();
  await syncSystemRoles(db());
});

afterEach(() => vi.unstubAllGlobals());

describe("蝦皮銷售報表", () => {
  it("有執行權限的人可以讀到預設區間與空設定", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-15T12:00:00.000Z") });
    try {
      const id = await seedUser("manager@ecotech.tw", "role-manager");
      const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/state");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ start: "2026-07-01", end: "2026-07-31", scopes: [], configured: true, latestRequestId: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("沒有 Drive 連結時不會啟動報表工作", async () => {
    const calls = stubRunner();
    await createReportManagementScope(db(), { id: "shopee:store:no-folder", sourceType: "shopee", scopeKind: "channel", name: "蝦皮測試" });
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "report.xlsx"));
    form.append("password", "042213");
    form.append("scopeId", "shopee:store:no-folder");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/upload", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("管理者設定 Drive 後，執行者可直接上傳報表並啟動背景工作", async () => {
    const calls = stubRunner();
    const admin = await seedUser("eli@ecotech.tw", "role-admin");
    // Drive 資料夾改在通路管理設定；這裡就是實際的操作路徑。
    const shopeeScopeId = (await getShopeeSalesSettings(db())).id;
    const selectedScopeId = "shopee:store:mall-b";
    await createReportManagementScope(db(), {
      id: selectedScopeId, sourceType: "shopee", scopeKind: "channel", name: "蝦皮二店",
      driveFolderUrl: "https://drive.google.com/drive/folders/folder456", driveFolderName: "蝦皮二店",
    });
    const saved = await as(admin, "eli@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(shopeeScopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "蝦皮", sourceType: "shopee", scopeKind: "channel",
        driveFolderUrl: "https://drive.google.com/drive/folders/folder123", driveFolderName: "蝦皮",
      }),
    });
    expect(saved.status).toBe(200);

    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    form.append("password", "042213");
    form.append("scopeId", selectedScopeId);
    const response = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/upload", { method: "POST", body: form });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(calls[0]?.url).toBe("/jobs");
    const inputs = calls[0]?.body ?? {};
    expect(inputs.driveFolderUrl).toBe("https://drive.google.com/drive/folders/folder456");
    expect(inputs.scopeId).toBe(selectedScopeId);
    expect(inputs.scopeName).toBe("蝦皮二店");
    expect(inputs.start).toBe("2025-02-01");
    expect(inputs.end).toBe("2025-02-28");
    const sourceUrl = String(inputs.sourceUrl);
    expect(sourceUrl).toContain("/api/internal/shopee-sales/source/");
    expect(await listShopeeSalesRuns(db())).toMatchObject([{ driveFolderUrl: "https://drive.google.com/drive/folders/folder456" }]);
    expect(await db().select({ scopeId: reportRunScopes.scopeId }).from(reportRunScopes)).toEqual([{ scopeId: selectedScopeId }]);
    expect(await db().select({ sourceType: reportRuns.sourceType, importsSales: reportRuns.importsSales, importsPayout: reportRuns.importsPayout }).from(reportRuns)).toEqual([
      { sourceType: "shopee", importsSales: 1, importsPayout: 1 },
    ]);
    expect(await db().select({ id: scopes.id, driveFolderUrl: scopes.driveFolderUrl }).from(scopes).where(eq(scopes.sourceType, "shopee"))).toContainEqual(
      { id: shopeeScopeId, driveFolderUrl: "https://drive.google.com/drive/folders/folder123" },
    );
    expect(await db().select({ driveFolderUrl: reportRunScopes.driveFolderUrl, driveFolderName: reportRunScopes.driveFolderName }).from(reportRunScopes)).toEqual([
      { driveFolderUrl: "https://drive.google.com/drive/folders/folder456", driveFolderName: "蝦皮二店" },
    ]);
    await as(admin, "eli@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(shopeeScopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ driveFolderUrl: "https://drive.google.com/drive/folders/folder456", driveFolderName: "蝦皮新資料夾" }),
    });
    expect(await listShopeeSalesRuns(db())).toMatchObject([{ driveFolderUrl: "https://drive.google.com/drive/folders/folder456" }]);
    const state = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/state");
    expect((await state.json()) as { latestRequestId: string }).toMatchObject({ latestRequestId: expect.any(String) });
    expect((await getShopeeSalesSettings(db())).driveFolderName).toBe("蝦皮新資料夾");
    const status = await as(manager, "manager@ecotech.tw", `/api/tools/shopee-sales/status?requestId=${encodeURIComponent(String(inputs.requestId))}`);
    expect(await status.json()).toMatchObject({ runs: [{
      status: "completed", conclusion: "success", driveUrl: "https://drive.google.com/file/d/file-id/view",
      driveFileAlreadyExisted: false, ingested: true, salesRows: 1, payoutRows: 1,
    }] });
    const requestId = String(inputs.requestId);
    calls.jobs.set(requestId, { requestId, status: "succeeded", result: { driveUrl: "https://drive.google.com/file/d/file-id/view", salesRows: 1, payoutRows: 1 } });
    const legacyStatus = await as(manager, "manager@ecotech.tw", `/api/tools/shopee-sales/status?requestId=${encodeURIComponent(requestId)}`);
    const legacyRun = ((await legacyStatus.json()) as { runs: Record<string, unknown>[] }).runs[0]!;
    expect(legacyRun).not.toHaveProperty("driveFileAlreadyExisted");
    expect(legacyRun).not.toHaveProperty("ingested");

    const source = await app.fetch(new Request(sourceUrl), env as never);
    expect(source.status).toBe(200);
    expect(source.headers.get("x-shopee-report-password")).toBe("MDQyMjEz");
    const cleanupUrl = sourceUrl.replace("/source/", "/cleanup/");
    expect((await app.fetch(new Request(cleanupUrl, { method: "POST" }), env as never)).status).toBe(200);
    expect((await app.fetch(new Request(sourceUrl), env as never)).status).toBe(404);
  });

  it("工作失敗時狀態 API 會傳回錯誤原因", async () => {
    const calls = stubRunner();
    const scopeId = "shopee:store:failed-run";
    await createReportManagementScope(db(), {
      id: scopeId, sourceType: "shopee", scopeKind: "channel", name: "蝦皮失敗測試",
      driveFolderUrl: "https://drive.google.com/drive/folders/failed-folder", driveFolderName: "蝦皮失敗測試",
    });
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    form.append("password", "042213");
    form.append("scopeId", scopeId);
    const started = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/upload", { method: "POST", body: form });
    expect(started.status).toBe(202);
    const { requestId } = await started.json() as { requestId: string };
    calls.jobs.set(requestId, { requestId, status: "failed", result: null, error: "搜尋 Drive 檔案失敗（HTTP 403）。" });

    const response = await as(manager, "manager@ecotech.tw", `/api/tools/shopee-sales/status?requestId=${encodeURIComponent(requestId)}`);
    expect(await response.json()).toMatchObject({ runs: [{
      status: "completed", conclusion: "failure", error: "搜尋 Drive 檔案失敗（HTTP 403）。",
    }] });
  });

  it("解析預覽不會匯入；確認後才另行啟動整理", async () => {
    const calls = stubRunner();
    const scopeId = "shopee:store:preview";
    await createReportManagementScope(db(), {
      id: scopeId, sourceType: "shopee", scopeKind: "channel", name: "蝦皮預覽",
      driveFolderUrl: "https://drive.google.com/drive/folders/preview-folder", driveFolderName: "蝦皮預覽",
    });
    const otherScopeId = "shopee:store:other-preview";
    await createReportManagementScope(db(), {
      id: otherScopeId, sourceType: "shopee", scopeKind: "channel", name: "另一個蝦皮通路",
      driveFolderUrl: "https://drive.google.com/drive/folders/other-preview-folder", driveFolderName: "另一個蝦皮通路",
    });
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    form.append("password", "042213");
    form.append("scopeId", scopeId);

    const started = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/preview", { method: "POST", body: form });
    expect(started.status, await started.clone().text()).toBe(202);
    const { requestId, previewToken } = await started.json() as { requestId: string; previewToken: string };
    const previewInputs = calls[0]?.body ?? {};
    expect(calls[0]?.url).toBe("/preview");
    expect(calls.runnerNames[0]).toBe("shopee-sales-report-runner");
    expect(calls.runnerModes[0]).toBe("shared");
    expect(previewInputs.requestId).toBe(requestId);
    expect(await listShopeeSalesRuns(db())).toEqual([]);

    const preview = {
      reportMonths: ["2025-02"], dailyPayoutRows: [{ businessDate: "2025-02-14", payoutAmount: 280 }], sourceRowCount: 3, rowCount: 1,
      rows: [{ reportMonth: "2025-02", sku: "SKU-1", productName: "商品一", grossQuantity: 3, returnQuantity: 0, netQuantity: 3, salesAmount: 300 }],
      uniqueOrders: 2, uniqueProducts: 1, totalPerformance: 280, totalQuantity: 3, totalSalesAmount: 300,
      duplicateRowsExcluded: 1, warnings: [],
    };
    const fetched = await as(manager, "manager@ecotech.tw", `/api/tools/shopee-sales/preview/${requestId}?token=${previewToken}`);
    expect(await fetched.json()).toEqual({ preview });

    const wrongPasswordForm = new FormData();
    wrongPasswordForm.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    wrongPasswordForm.append("password", "wrong-password");
    wrongPasswordForm.append("requestId", requestId);
    wrongPasswordForm.append("previewToken", previewToken);
    wrongPasswordForm.append("scopeId", scopeId);
    expect((await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/confirm", {
      method: "POST", body: wrongPasswordForm,
    })).status).toBe(409);
    expect(calls.filter((call) => call.url === "/jobs")).toHaveLength(0);

    const wrongScopeForm = new FormData();
    wrongScopeForm.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    wrongScopeForm.append("password", "042213");
    wrongScopeForm.append("requestId", requestId);
    wrongScopeForm.append("previewToken", previewToken);
    wrongScopeForm.append("scopeId", otherScopeId);
    const wrongScope = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/confirm", {
      method: "POST", body: wrongScopeForm,
    });
    expect(wrongScope.status).toBe(409);
    expect(await wrongScope.json()).toMatchObject({ error: "確認匯入的通路與預覽不一致，請重新選擇通路並解析報表。" });
    expect(calls.filter((call) => call.url === "/jobs")).toHaveLength(0);

    const sourceUrl = String(previewInputs.sourceUrl);
    const cleanupUrl = sourceUrl.replace("/source/", "/cleanup/");
    expect((await app.fetch(new Request(cleanupUrl, { method: "POST" }), env as never)).status).toBe(200);

    const confirmForm = new FormData();
    confirmForm.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    confirmForm.append("password", "042213");
    confirmForm.append("requestId", requestId);
    confirmForm.append("previewToken", previewToken);
    confirmForm.append("scopeId", scopeId);
    const confirmed = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/confirm", {
      method: "POST", body: confirmForm,
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(202);
    const processCall = calls.find((call) => call.url === "/jobs");
    expect(processCall).toBeDefined();
    const processInputs = processCall?.body ?? {};
    expect(processInputs.sourceUrl).not.toBe(previewInputs.sourceUrl);
    expect(await listShopeeSalesRuns(db())).toMatchObject([{ startDate: "2025-02-01", endDate: "2025-02-28" }]);
    const processSource = await app.fetch(new Request(String(processInputs.sourceUrl)), env as never);
    expect(processSource.status).toBe(200);
    expect(await db().select({ scopeId: reportRunScopes.scopeId }).from(reportRunScopes)).toEqual([{ scopeId }]);
    expect((await as(manager, "manager@ecotech.tw", `/api/tools/shopee-sales/preview/${requestId}?token=${previewToken}`)).status).toBe(404);
  });

  it("通路設定權限可以讀蝦皮報表設定", async () => {
    await db().insert(roles).values({ id: "role-tools-config", roleKey: "tools-config", name: "通路設定", isSystem: false });
    await db().insert(rolePermissionGrants).values([
      { roleId: "role-tools-config", permission: "tools:payout:config" },
      { roleId: "role-tools-config", permission: "reports:cyberbiz:write" },
    ]);
    const id = await seedUser("tools-config@ecotech.tw", "role-tools-config");

    expect((await as(id, "tools-config@ecotech.tw", "/api/tools/shopee-sales/settings")).status).toBe(200);

    // 寫入改走通路管理，不再有第二個設定端點。
    const scopeId = (await getShopeeSalesSettings(db())).id;
    const saved = await as(id, "tools-config@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(scopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ driveFolderUrl: "https://drive.google.com/drive/folders/folder123" }),
    });
    expect(saved.status).toBe(200);
  });

  it("檢視者不能執行", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/shopee-sales/state");
    expect(response.status).toBe(403);
  });
});
