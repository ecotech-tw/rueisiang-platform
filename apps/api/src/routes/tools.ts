import {
  addProductSkuMapping,
  addReportSkuIgnore,
  deleteProductSkuMapping,
  deleteReportSkuIgnore,
  findReportScope,
  listReportSkuIgnores,
  loadProductSkuMappingManagement,
  updateProductSkuMapping,
  insertReportPayoutDaily,
  archiveReportManagementScope,
  createReportManagementScope,
  isValidScopeId,
  listReportManagementScopes,
  ReportManualError,
  type ScopeKind,
  updateReportManagementScope,
  listReportScopes,
  normalizeReportScopeName,
  ReportScopeAmbiguousError,
  listPayoutRuns,
  listCyberbizProducts,
  listPayoutStores,
  recordPayoutRun,
  upsertReportScope,
  type Database,
  type ProductBundleComponentInput,
} from "@rueisiang/db";
import { can } from "@rueisiang/auth";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { payoutGithub } from "../payout/github.js";
import { body, requireString } from "../request.js";
import { forgetReportAnalytics } from "../report-cache.js";
import { cacheClient } from "../upstash.js";
import { createCyberbizReportIngestor, CyberbizReportIngestError } from "../cyberbiz-report-ingest.js";

/** 只取字串欄位；沒帶就是 undefined（代表「這次不動它」），不是空字串。 */
function text(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * 組合用料一律直接指向 target items；這裡只負責驗證 JSON 並攤成型別對的形狀。
 */
function bundleComponents(input: Record<string, unknown>): ProductBundleComponentInput[] {
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new HTTPException(400, { message: "至少要設定一個組合用料。" });
  }
  return input.components.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HTTPException(400, { message: "組合用料的格式不正確。" });
    }
    const component = value as Record<string, unknown>;
    const quantity = component.quantity;
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new HTTPException(400, { message: "組合用料數量必須是大於 0 的整數。" });
    }
    const itemId = typeof component.itemId === "string" ? component.itemId.trim() : "";
    if (!itemId) throw new HTTPException(400, { message: "SKU 對應必須直接選擇品項。" });
    return { itemId, quantity };
  });
}

import { cyberbizScopeIdFromStoreName, manualScopeIdFromStoreName, runnerStores } from "../cyberbiz-scope.js";
import { cyberbizSales } from "./cyberbiz-sales.js";
import { shopeeSales } from "./shopee-sales.js";

/**
 * 營運工具。出金表與 CYBERBIZ 商品銷售報表都由這裡統一掛載。
 *
 * 執行模式跟舊的 Worker 一模一樣：按下去就 workflow_dispatch 一個 GitHub Actions
 * 工作，再輪詢狀態。平台不開瀏覽器、不碰 CYBERBIZ 或 Google 的憑證。
 *
 * 換掉的只有入口。舊版是一個誰拿到網址都能按的公開頁面；現在要登入、要
 * tools:payout:run，而且每次執行都留下是誰按的——出金表會動到正式帳務的 Drive
 * 檔案，事後查不出人是最麻煩的情況。
 */

/** 上個月的起訖日（Asia/Taipei）。同仁月初做帳，預設就是上個月。 */
function previousMonthRange(): { start: string; end: string } {
  // Worker 一律跑 UTC，所以自己加 8 小時再取年月，才不會在台灣時間 1 號早上
  // 算成再上一個月。
  const taipei = new Date(Date.now() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth(); // 0-based，剛好就是上個月
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  const padded = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${padded}-01`, end: `${year}-${padded}-${lastDay}` };
}

/**
 * 擋掉格式錯誤，也擋掉 2026-02-30 這種日曆上不存在的日期——Date 會自己把它
 * 捲到 3/2，所以要拿解析回來的字串比對原字串。
 */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isCompleteMonth(start: string, end: string): boolean {
  const [year = 0, month = 0] = start.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  return start === monthStart && end === monthEnd;
}


const MAX_MANUAL_SALES_ROWS = 20_000;

/** 手動 sales 仍是 CYBERBIZ 報表；manual scope 只是沒有自動抓取來源的店別。 */
function isCyberbizSalesScopeId(scopeId: string): boolean {
  return scopeId.length <= 100 && (/^(?:cyberbiz|manual):store:/i.test(scopeId) || /^store-/i.test(scopeId));
}

/**
 * 要新建據點時，先確認這個名字沒有被別的 scope 用掉。
 *
 * 同名 scope 會讓 findReportScope({ name }) 從此丟 ReportScopeAmbiguousError，而且據點
 * 下拉選單以名稱為 key，只會留下其中一個——另一個的歷史資料使用者再也選不到。與其事後
 * 補救，不如在建立的當下擋掉，請使用者直接從清單選既有據點。
 */
async function assertStoreScopeNameFree(db: Database, scopeId: string, scopeName: string): Promise<void> {
  let sameName;
  try {
    sameName = await findReportScope(db, { scopeKind: "store", name: scopeName });
  } catch (error) {
    if (error instanceof ReportScopeAmbiguousError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
  if (sameName && sameName.id !== scopeId) {
    throw new HTTPException(400, {
      message: `已經有名為「${scopeName}」的據點，請直接從據點清單選擇，不要另外新建同名據點。`,
    });
  }
}

function isValidReportMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function manualSalesInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HTTPException(400, { message: `${label} 必須是安全範圍內的整數。` });
  }
  return value;
}

export const tools = new Hono<AppEnv>()
  .use("*", requireAuth)

  /**
   * 手動上傳的出金資料。
   *
   * 退租 POS 的店在 CYBERBIZ 已經抓不到，但歷史出金還是要進報表。檔案在瀏覽器端解析
   * （Worker 讀 xlsx 要自己拆 zip，不划算），這裡只收已經整理好的日資料。
   *
   * 逐日 upsert，所以同一份重傳、或分次傳半個月都安全——這也是為什麼 payout 不像
   * sales 那樣要求完整月份。
   */
  .get("/manual-payout/scopes", requirePermission("tools:payout:config"), async (c) => {
    const scopes = await listReportScopes(c.get("db"), "store");
    return c.json({ scopes: scopes.map((scope) => ({ id: scope.id, name: scope.name })) });
  })

  .post("/manual-payout", requirePermission("tools:payout:config"), async (c) => {
    const input = await body(c);
    const scopeName = requireString(input, "scopeName", "據點名稱");
    // 既有據點沿用它的 ID，才不會讓同一家店的歷史被拆成兩個 scope。
    const requestedScopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
    const scopeId = requestedScopeId && isValidScopeId(requestedScopeId)
      ? requestedScopeId
      : manualScopeIdFromStoreName(scopeName);

    if (!Array.isArray(input.rows) || !input.rows.length) {
      throw new HTTPException(400, { message: "沒有可匯入的出金資料。" });
    }
    const rows = input.rows.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HTTPException(400, { message: "出金資料格式不正確。" });
      }
      const row = value as Record<string, unknown>;
      const businessDate = requireString(row, "businessDate", "關帳日期");
      if (!isValidDate(businessDate)) {
        throw new HTTPException(400, { message: `關帳日期格式不正確：${businessDate}` });
      }
      const payoutAmount = row.payoutAmount;
      if (typeof payoutAmount !== "number" || !Number.isFinite(payoutAmount)) {
        throw new HTTPException(400, { message: `${businessDate} 的金額不是數字。` });
      }
      const roundedAmount = Math.round(payoutAmount);
      if (!Number.isSafeInteger(roundedAmount)) {
        throw new HTTPException(400, { message: `${businessDate} 的金額超出可安全儲存的整數範圍。` });
      }
      return { scopeId, businessDate, payoutAmount: roundedAmount };
    });

    const amountsByDate = new Map<string, number>();
    for (const row of rows) {
      const total = (amountsByDate.get(row.businessDate) ?? 0) + row.payoutAmount;
      if (!Number.isSafeInteger(total)) {
        throw new HTTPException(400, { message: `${row.businessDate} 的金額加總超出可安全儲存的整數範圍。` });
      }
      amountsByDate.set(row.businessDate, total);
    }
    const dailyRows = [...amountsByDate].map(([businessDate, payoutAmount]) => ({
      scopeId,
      businessDate,
      payoutAmount,
    }));

    await assertStoreScopeNameFree(c.get("db"), scopeId, scopeName);
    let scope;
    try {
      scope = await upsertReportScope(c.get("db"), { id: scopeId, scopeKind: "store", name: scopeName });
      await insertReportPayoutDaily(c.get("db"), dailyRows);
    } finally {
      // 寫完 scope 才在寫日資料時失敗也算改到報表；成功與失敗都要清掉報表快取。
      await forgetReportAnalytics(cacheClient(c.env));
    }
    const dates = dailyRows.map((row) => row.businessDate).sort();
    return c.json({
      scopeId: scope.id,
      scopeName: scope.name,
      dayCount: dailyRows.length,
      total: dailyRows.reduce((sum, row) => sum + row.payoutAmount, 0),
      coverageStart: dates[0],
      coverageEnd: dates[dates.length - 1],
    }, 201);
  })

  /** 手動補上的 CYBERBIZ 商品銷售；整月快照會取代同店同月份的既有資料。 */
  .get("/manual-sales/scopes", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    const [reportScopes, configuredStores] = await Promise.all([
      listReportScopes(c.get("db"), "store"),
      listPayoutStores(c.get("db")),
    ]);
    // 以名稱去重只用來決定「哪些設定的店還沒有 scope」；既有 scope 一律全部列出，
    // 不然正式環境已經存在的同名 scope 會有一個永遠選不到，它的歷史資料等於消失。
    const scopes: { id: string; name: string }[] = [];
    const named = new Set<string>();
    for (const scope of reportScopes) {
      if (!isCyberbizSalesScopeId(scope.id)) continue;
      named.add(normalizeReportScopeName(scope.name));
      scopes.push({ id: scope.id, name: scope.name });
    }
    for (const store of configuredStores) {
      const key = normalizeReportScopeName(store.name);
      if (named.has(key)) continue;
      named.add(key);
      scopes.push({ id: cyberbizScopeIdFromStoreName(store.name), name: store.name });
    }
    return c.json({
      scopes: scopes.sort((a, b) => a.name.localeCompare(b.name, "zh-TW")),
    });
  })

  /** 手動 sales 舊檔以商品名稱對 SKU 時使用的目錄；沿用 sales 權限，不要求另開 SKU 設定頁。 */
  .get("/manual-sales/products", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    return c.json({ products: await listCyberbizProducts(c.get("db")) });
  })

  .post("/manual-sales", requirePermission("tools:cyberbiz-sales:run"), async (c) => {
    const input = await body(c);
    const scopeName = requireString(input, "scopeName", "據點名稱");
    const reportMonth = requireString(input, "reportMonth", "報表月份");
    if (!isValidReportMonth(reportMonth)) {
      throw new HTTPException(400, { message: "報表月份格式必須是 YYYY-MM。" });
    }
    const rawRows = input.rows;
    if (!Array.isArray(rawRows) || rawRows.length > MAX_MANUAL_SALES_ROWS) {
      throw new HTTPException(400, {
        message: Array.isArray(rawRows) && rawRows.length
          ? `商品銷售資料不能超過 ${MAX_MANUAL_SALES_ROWS.toLocaleString("zh-TW")} 列。`
          : "沒有可匯入的商品銷售資料。",
      });
    }
    if (!rawRows.length) throw new HTTPException(400, { message: "沒有可匯入的商品銷售資料。" });

    const requestedScopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
    let scopeId = manualScopeIdFromStoreName(scopeName);
    let resolvedScopeName = scopeName;
    let existingScope = null;
    if (requestedScopeId) {
      if (!isCyberbizSalesScopeId(requestedScopeId)) {
        throw new HTTPException(400, { message: "匯入據點 ID 格式不正確。" });
      }
      const selectedScope = await findReportScope(c.get("db"), { scopeKind: "store", id: requestedScopeId });
      existingScope = selectedScope;
      if (selectedScope) {
        if (normalizeReportScopeName(selectedScope.name) !== normalizeReportScopeName(scopeName)) {
          throw new HTTPException(400, { message: "匯入據點 ID 與據點名稱不一致，請重新選擇據點。" });
        }
        scopeId = selectedScope.id;
        resolvedScopeName = selectedScope.name;
      } else if (
        requestedScopeId !== cyberbizScopeIdFromStoreName(scopeName)
        && requestedScopeId !== manualScopeIdFromStoreName(scopeName)
      ) {
        throw new HTTPException(400, { message: "找不到指定的匯入據點，請重新選擇據點。" });
      } else {
        scopeId = requestedScopeId;
      }
    }
    // sales 是整月覆寫，寫錯 scope 等於把那家店當月的自動匯入資料清掉，所以新建據點前
    // 一定要確認名字沒有被別人用走。
    if (!existingScope) {
      await assertStoreScopeNameFree(c.get("db"), scopeId, scopeName);
    }
    const rows = rawRows.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HTTPException(400, { message: `第 ${index + 1} 列商品銷售資料格式不正確。` });
      }
      const row = value as Record<string, unknown>;
      if (row.reportMonth !== undefined && row.reportMonth !== reportMonth) {
        throw new HTTPException(400, { message: `第 ${index + 1} 列的報表月份與檔案不一致。` });
      }
      const sku = requireString(row, "sku", `第 ${index + 1} 列 SKU`);
      return {
        reportMonth,
        sku,
        grossQuantity: manualSalesInteger(row.grossQuantity, `第 ${index + 1} 列銷售數量`),
        returnQuantity: manualSalesInteger(row.returnQuantity, `第 ${index + 1} 列退回數量`),
        netQuantity: manualSalesInteger(row.netQuantity, `第 ${index + 1} 列淨銷售數量`),
        salesAmount: manualSalesInteger(row.salesAmount, `第 ${index + 1} 列售額總計`),
      };
    });

    let result;
    try {
      result = await createCyberbizReportIngestor(c.get("db")).ingest({
        kind: "sales",
        scopeType: "store",
        scopeId,
        scopeName: resolvedScopeName,
        reportMonth,
        rows,
      });
    } catch (error) {
      if (error instanceof CyberbizReportIngestError) {
        throw new HTTPException(422, { message: error.message });
      }
      throw error;
    } finally {
      // ingest 可能已先寫入 scope 或部分批次後才失敗；成功與失敗都要清掉報表快取。
      await forgetReportAnalytics(cacheClient(c.env));
    }
    return c.json({ ...result, scopeName: resolvedScopeName, reportMonth }, 201);
  })

  /** SKU 對應的入口已移到品項管理；API 路徑先保留在 tools 之下，避免既有前端與報表流程斷線。 */
  .get("/product-sku-mappings", requirePermission("wms:mapping:read"), async (c) => {
    return c.json(await loadProductSkuMappingManagement(c.get("db")));
  })

  /** 建立一筆通路商品 mapping；至少要有一個用料，WMS 品項會參與庫存扣料。 */
  .post("/product-sku-mappings", requirePermission("wms:mapping:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await addProductSkuMapping(c.get("db"), {
      components: bundleComponents(input),
      channel: input.channel === undefined ? undefined : requireString(input, "channel", "通路"),
      externalName: requireString(input, "externalName", "通路商品名稱"),
      externalSku: requireString(input, "externalSku", "外部 SKU"),
      actor: { id: user.id, email: user.email },
    });
    await forgetReportAnalytics(cacheClient(c.env));
    return c.json(result, 201);
  })

  .patch("/product-sku-mappings/:mappingId", requirePermission("wms:mapping:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await updateProductSkuMapping(c.get("db"), {
      id: c.req.param("mappingId"),
      channel: input.channel === undefined ? undefined : requireString(input, "channel", "通路"),
      externalName: requireString(input, "externalName", "通路商品名稱"),
      externalSku: requireString(input, "externalSku", "外部 SKU"),
      components: bundleComponents(input),
      actor: { id: user.id, email: user.email },
    });
    await forgetReportAnalytics(cacheClient(c.env));
    return c.json(result);
  })

  /**
   * 刻意不納入報表的外部 SKU。
   *
   * 與「還沒建對應」在匯入端行為相同（都略過），差別只在要不要提醒——標記過的不再吵。
   */
  .get("/report-sku-ignores", requirePermission("wms:mapping:read"), async (c) => {
    return c.json({ ignores: await listReportSkuIgnores(c.get("db")) });
  })

  .post("/report-sku-ignores", requirePermission("wms:mapping:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await addReportSkuIgnore(c.get("db"), {
      channel: requireString(input, "channel", "通路"),
      externalSku: requireString(input, "externalSku", "外部 SKU"),
      reason: text(input, "reason"),
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .delete("/report-sku-ignores/:id", requirePermission("wms:mapping:write"), async (c) => {
    const user = c.get("user");
    await deleteReportSkuIgnore(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  .delete("/product-sku-mappings/:mappingId", requirePermission("wms:mapping:write"), async (c) => {
    const user = c.get("user");
    await deleteProductSkuMapping(c.get("db"), c.req.param("mappingId"), { id: user.id, email: user.email });
    await forgetReportAnalytics(cacheClient(c.env));
    return c.json({ ok: true });
  })


  .route("/shopee-sales", shopeeSales)
  .route("/cyberbiz-sales", cyberbizSales)

  /** 執行頁一開始要的東西：店別、預設區間、以及後端到底有沒有接上 GitHub。 */
  .get("/payout/state", requirePermission("tools:payout:run"), async (c) => {
    const stores = await listPayoutStores(c.get("db"), { enabledOnly: true });
    const range = previousMonthRange();
    const runs = await listPayoutRuns(c.get("db"), 10);
    return c.json({
      stores: stores.map((store) => ({
        name: store.name,
        scopeId: store.id,
        folder: store.driveFolderName,
        // 連結帶出去，執行頁就能直接點進 Drive 看跑出來的檔案。
        folderUrl: store.driveFolderUrl,
      })),
      defaultStart: range.start,
      defaultEnd: range.end,
      // 沒設定 token 時要讓畫面說得出原因，而不是等按下去才報錯。
      configured: Boolean(payoutGithub(c.env)),
      /*
       * 最近一次執行的識別碼。重新整理或離開再回來時，畫面要能自己接回去問
       * 狀態——不然人會不知道上一次到底跑完了沒，只好再按一次。
       */
      latestRequestId: runs[0]?.requestId ?? null,
      runs,
    });
  })

  .post("/payout/run", requirePermission("tools:payout:run"), async (c) => {
    const input = await body(c);
    const github = payoutGithub(c.env);
    if (!github) {
      throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN，無法觸發執行。" });
    }

    const requested = Array.isArray(input.stores) ? input.stores.map(String) : [];
    if (!requested.length) throw new HTTPException(400, { message: "沒有選到任何店。" });
    if (new Set(requested).size !== requested.length) {
      throw new HTTPException(400, { message: "店別不能重複。" });
    }

    const configuredStores = await listPayoutStores(c.get("db"));
    const known = configuredStores.filter((store) => store.enabled).map((store) => store.name);
    const unknown = requested.filter((name) => !known.includes(name));
    if (unknown.length) throw new HTTPException(400, { message: `不認得的通路：${unknown.join("、")}` });

    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    if (!isValidDate(start) || !isValidDate(end)) {
      throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
    }
    if (start > end) throw new HTTPException(400, { message: "起日不能晚於迄日。" });

    const isAll = requested.length === known.length && known.every((name) => requested.includes(name));
    /*
     * workflow 的輸入仍保留「全部」給完整清單；多家店則傳 JSON 陣列，由 workflow
     * 拆成多個 --store。店別開關關掉時不能傳「全部」，不然 runner 會把被隱藏的店也跑下去。
     */
    const store = isAll && requested.length === configuredStores.length
      ? "全部"
      : requested.length === 1
        ? requested[0]!
        : JSON.stringify(requested);

    const requestId = crypto.randomUUID();
    await github.dispatch({
      store,
      stores: runnerStores(configuredStores.filter((item) => requested.includes(item.name))),
      start,
      end,
      requestId,
    });

    // 先觸發再記錄：GitHub 沒收下的話，這裡不該留下一筆看起來跑過的紀錄。
    const user = c.get("user");
    await recordPayoutRun(c.get("db"), {
      requestId,
      stores: requested,
      scopeIds: configuredStores.filter((store) => requested.includes(store.name)).map((store) => store.id),
      periodKind: isCompleteMonth(start, end) ? "month" : "custom",
      startDate: start,
      endDate: end,
      actor: { id: user.id, email: user.email },
    });

    return c.json({ requestId, store, start, end }, 202);
  })

  .get("/payout/status", requirePermission("tools:payout:run"), async (c) => {
    const github = payoutGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN。" });

    const requestId = c.req.query("requestId") ?? undefined;
    return c.json(await github.listRuns(requestId));
  })


  /**
   * 通路管理。
   *
   * 一張 scopes 表原本有兩個管理入口（店別與報表設定、報表管理→管理據點），兩邊
   * 篩選條件不同、刪除行為不同，卻寫同一個 active 欄位——在其中一邊關掉一家店，
   * 另一邊的執行頁也會跟著消失。合成這一組之後只有一個地方管。
   */
  .get("/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    const scopes = await listReportManagementScopes(c.get("db"));
    return c.json({ scopes: scopes.map((scope) => redactScope(scope, canConfigure(c))) });
  })

  .post("/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "通路名稱");
    try {
      const scope = await createReportManagementScope(c.get("db"), {
        id: scopeIdFor(input, name),
        name,
        ...scopeFields(input, canConfigure(c)),
      });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope: redactScope(scope, canConfigure(c)) }, 201);
    } catch (error) {
      throw scopeError(error);
    }
  })

  .patch("/scopes/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    const input = await body(c);
    try {
      const scope = await updateReportManagementScope(c.get("db"), {
        id: c.req.param("id"),
        ...("name" in input ? { name: requireString(input, "name", "通路名稱") } : {}),
        ...scopeFields(input, canConfigure(c)),
      });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope: redactScope(scope, canConfigure(c)) });
    } catch (error) {
      throw scopeError(error);
    }
  })

  /** 封存，不刪除：出金、銷售、報表執行與人事指派都指著這個 ID。 */
  .post("/scopes/:id/archive", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const scope = await archiveReportManagementScope(c.get("db"), c.req.param("id"));
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope: redactScope(scope, canConfigure(c)) });
    } catch (error) {
      throw scopeError(error);
    }
  });

/**
 * 通路管理的權限分兩層，跟合併前一樣：
 *
 * - `reports:cyberbiz:write`（主管也有）：看清單、新增、改名、停用與封存。
 * - `tools:payout:config`（只有管理者）：來源、種類、外部店名與 Drive 資料夾。
 *
 * 外部店名屬於後者，因為它決定 runner 去 CYBERBIZ 後台抓哪一家店的錢——那跟
 * 「這個通路在平台上叫什麼」是兩件事。
 *
 * 兩頁合併成一頁不該順便放寬權限。Drive 連結對沒有 config 權限的人整個不回傳，
 * 不是只有畫面上藏起來——SPA 的 JavaScript 全在使用者手上。
 */
function canConfigure(c: Context<AppEnv>): boolean {
  return can(c.get("user"), "tools:payout:config");
}

function redactScope<T extends { driveFolderUrl: string; driveFolderName: string }>(scope: T, configurable: boolean): T {
  return configurable ? scope : { ...scope, driveFolderUrl: "", driveFolderName: "" };
}

/** 沒送的欄位不動，送空字串就是清掉。沒有 config 權限時送了設定欄位一律 403。 */
function scopeFields(input: Record<string, unknown>, configurable: boolean) {
  const fields: {
    externalName?: string; sourceType?: string; scopeKind?: ScopeKind;
    driveFolderUrl?: string; driveFolderName?: string; active?: boolean;
  } = {};
  const configured = ["sourceType", "scopeKind", "driveFolderUrl", "driveFolderName", "externalName"]
    .filter((key) => key in input);
  if (configured.length && !configurable) {
    throw new HTTPException(403, { message: "只有管理者可以改通路的來源、種類、外部店名與 Drive 設定。" });
  }
  for (const key of ["externalName", "sourceType", "driveFolderUrl", "driveFolderName"] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string") throw new HTTPException(400, { message: `${key} 必須是文字。` });
    fields[key] = (input[key] as string).trim();
  }
  // 空的允許（還沒建資料夾），但填了就要真的是 Drive 資料夾連結——貼錯連結會讓
  // 整批報表上傳到別的地方，而那是跑完才會發現的。
  if (fields.driveFolderUrl && !/^https?:\/\/[^\s]*(\/folders\/[\w-]+|[?&]id=[\w-]+)/.test(fields.driveFolderUrl)) {
    throw new HTTPException(400, { message: "Google Drive 資料夾連結格式不正確。" });
  }
  if ("scopeKind" in input) {
    if (typeof input.scopeKind !== "string") throw new HTTPException(400, { message: "通路種類必須是文字。" });
    fields.scopeKind = input.scopeKind as ScopeKind;
  }
  if ("active" in input) {
    if (typeof input.active !== "boolean") throw new HTTPException(400, { message: "啟用開關必須是布林值。" });
    fields.active = input.active;
  }
  return fields;
}

/**
 * 新通路的 ID。
 *
 * 送 ID 就用送的，沒送就從名稱產一個。ID 是永久的——出金與銷售資料都指著它，
 * 所以改名不會換 ID，也不該換。
 */
function scopeIdFor(input: Record<string, unknown>, name: string): string {
  const requested = typeof input.id === "string" ? input.id.trim() : "";
  if (!requested) return manualScopeIdFromStoreName(name);
  if (!isValidScopeId(requested)) throw new HTTPException(400, { message: "通路 ID 含有不允許的字元。" });
  return requested;
}

function scopeError(error: unknown): HTTPException {
  if (error instanceof ReportManualError) {
    const status = error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400;
    return new HTTPException(status, { message: error.message });
  }
  if (error instanceof HTTPException) return error;
  throw error;
}
