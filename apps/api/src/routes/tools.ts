import {
  addProductSkuMapping,
  addReportSkuIgnore,
  deleteProductSkuMapping,
  deleteReportSkuIgnore,
  listReportSkuIgnores,
  loadProductSkuMappingManagement,
  updateProductSkuMapping,
  archiveReportManagementScope,
  createReportManagementScope,
  isValidScopeId,
  findReportScope,
  listReportManagementScopes,
  findMediaCdnImage,
  ReportManualError,
  type ScopeKind,
  updateReportManagementScope,
  listPayoutRuns,
  listPayoutStores,
  recordPayoutRun,
  type ProductBundleComponentInput,
} from "@rueisiang/db";
import { can } from "@rueisiang/auth";
import { isReportPlatform } from "@rueisiang/db/report-platforms";
import { STORE_LOCATOR_PIN_BOUNDS } from "@rueisiang/db/store-locator-coordinates";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { payoutGithub } from "../payout/github.js";
import { body, requireString } from "../request.js";
import { forgetReportAnalytics } from "../report-cache.js";
import { cacheClient } from "../upstash.js";
import { createCyberbizReportIngestor, CyberbizReportIngestError } from "../cyberbiz-report-ingest.js";
import { GoogleMapsSearchError, searchGooglePlaces } from "../google-maps.js";

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

import { reportManagementScopeIdFromName, runnerStores } from "../cyberbiz-scope.js";

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
import { cyberbizSales } from "./cyberbiz-sales.js";
import { shopeeSales } from "./shopee-sales.js";
import { shopReport } from "./shop-report.js";
import { reportRuns } from "./report-runs.js";

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

function isCompleteMonth(start: string, end: string): boolean {
  const [year = 0, month = 0] = start.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  return start === monthStart && end === monthEnd;
}



export const tools = new Hono<AppEnv>()
  .use("*", requireAuth)

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
  .route("/shop-report", shopReport)
  .route("/reports/runs", reportRuns)

  .get("/reports/momo/scopes", requirePermission("tools:momo-report:run"), async (c) => {
    const scopes = await listReportManagementScopes(c.get("db"));
    return c.json({ scopes: scopes
      .filter((scope) => scope.sourceType === "momo" && scope.scopeKind === "channel" && scope.active)
      .map(({ id, name }) => ({ id, name })) });
  })

  .post("/reports/momo/import", requirePermission("tools:momo-report:run"), async (c) => {
    const input = await body(c);
    const scopeId = requireString(input, "scopeId", "Mo+ 通路");
    if (!Array.isArray(input.salesRows) || input.salesRows.length > 10_000) {
      throw new HTTPException(400, { message: "商品列數不得超過 10,000 列。" });
    }
    if (!Array.isArray(input.payoutRows) || input.payoutRows.length > 10_000) {
      throw new HTTPException(400, { message: "每日出金列數不得超過 10,000 列。" });
    }
    if (!input.salesRows.length && !input.payoutRows.length) {
      throw new HTTPException(400, { message: "檔案中沒有可匯入的商品銷售或每日出金資料。" });
    }
    const scope = await findReportScope(c.get("db"), { scopeKind: "channel", id: scopeId });
    if (!scope || scope.sourceType !== "momo" || !scope.active) {
      throw new HTTPException(400, { message: "請選擇啟用中的 Mo+ 通路。" });
    }
    const user = c.get("user");
    try {
      const result = await createCyberbizReportIngestor(c.get("db")).ingest({
        kind: "sales_and_payout",
        scopeType: "channel",
        scopeId: scope.id,
        scopeName: scope.name,
        salesRows: input.salesRows,
        payoutRows: input.payoutRows,
        sourceFileName: requireString(input, "sourceFileName", "Mo+ 對帳明細檔名"),
        requestId: `momo-upload:${crypto.randomUUID()}`,
        actorEmail: user.email,
      });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof CyberbizReportIngestError) {
        throw new HTTPException(error.status, { message: error.message });
      }
      throw error;
    }
  })

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
  .get("/scopes/places", requirePermission("reports:cyberbiz:write"), async (c) => {
    c.header("Cache-Control", "private, no-store");
    const query = c.req.query("query")?.trim() ?? "";
    if (!query || query.length > 100) throw new HTTPException(400, { message: "請輸入 1～100 字的地點搜尋關鍵字。" });
    const apiKey = c.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new HTTPException(503, { message: "尚未設定 Google Maps 搜尋服務，請聯絡管理者。" });
    try {
      return c.json({ places: await searchGooglePlaces(query, apiKey) });
    } catch (error) {
      if (error instanceof GoogleMapsSearchError) throw new HTTPException(502, { message: error.message });
      throw error;
    }
  })

  .get("/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    const scopes = await listReportManagementScopes(c.get("db"));
    return c.json({ scopes: scopes.map((scope) => redactScope(scope, canConfigure(c))) });
  })

  .post("/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "通路名稱");
    try {
      const fields = scopeFields(input, canConfigure(c));
      if (fields.storeLocatorImageId) {
        const image = await findMediaCdnImage(c.get("db"), fields.storeLocatorImageId);
        if (!image || image.deletedAt || !image.objectKey) throw new HTTPException(400, { message: "請選擇媒體庫中仍可使用的圖片。" });
      }
      const sourceType = fields.sourceType ?? "cyberbiz";
      const scope = await createReportManagementScope(c.get("db"), {
        id: scopeIdFor({ ...input, sourceType }, name),
        name,
        ...fields,
        sourceType,
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
      const fields = scopeFields(input, canConfigure(c));
      if (fields.storeLocatorImageId) {
        const image = await findMediaCdnImage(c.get("db"), fields.storeLocatorImageId);
        if (!image || image.deletedAt || !image.objectKey) throw new HTTPException(400, { message: "請選擇媒體庫中仍可使用的圖片。" });
      }
      const scope = await updateReportManagementScope(c.get("db"), {
        id: c.req.param("id"),
        ...("name" in input ? { name: requireString(input, "name", "通路名稱") } : {}),
        ...fields,
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
    storeLocatorCategory?: string; storeLocatorLabel?: string; storeLocatorShortName?: string;
    storeLocatorCounty?: string; storeLocatorAddress?: string; storeLocatorFloorNote?: string;
    storeLocatorHours?: string; storeLocatorPhone?: string; storeLocatorHighlight?: string;
    storeLocatorImageId?: string | null; storeLocatorImageUrl?: string; storeLocatorMapUrl?: string;
    storeLocatorPinX?: number | null; storeLocatorPinY?: number | null;
  } = {};
  const configured = ["sourceType", "scopeKind", "driveFolderUrl", "driveFolderName", "externalName"]
    .filter((key) => key in input);
  if (configured.length && !configurable) {
    throw new HTTPException(403, { message: "只有管理者可以改通路的來源、種類、外部店名與 Drive 設定。" });
  }
  for (const key of ["externalName", "sourceType", "driveFolderUrl", "driveFolderName"] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string") throw new HTTPException(400, { message: `${key} 必須是文字。` });
    const value = (input[key] as string).trim();
    fields[key] = key === "sourceType" ? value.toLowerCase() : value;
  }
  if (fields.sourceType && !isReportPlatform(fields.sourceType)) {
    throw new HTTPException(400, { message: "平台必須是有效的報表來源。" });
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
  const locatorTextFields = [
    "storeLocatorCategory", "storeLocatorLabel", "storeLocatorShortName", "storeLocatorCounty",
    "storeLocatorAddress", "storeLocatorFloorNote", "storeLocatorHours", "storeLocatorPhone",
    "storeLocatorHighlight", "storeLocatorMapUrl",
  ] as const;
  for (const key of locatorTextFields) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string" || input[key].length > 500) throw new HTTPException(400, { message: `${key} 必須是 500 字以內的文字。` });
    fields[key] = (input[key] as string).trim();
  }
  if ("storeLocatorImageId" in input) {
    if (input.storeLocatorImageId !== null && typeof input.storeLocatorImageId !== "string") throw new HTTPException(400, { message: "圖片 ID 格式不正確。" });
    fields.storeLocatorImageId = typeof input.storeLocatorImageId === "string" && input.storeLocatorImageId.trim() ? input.storeLocatorImageId.trim() : null;
  }
  if ("storeLocatorImageUrl" in input) {
    if (typeof input.storeLocatorImageUrl !== "string" || input.storeLocatorImageUrl.length > 2048) throw new HTTPException(400, { message: "圖片網址需為 2048 字以內的文字。" });
    const value = input.storeLocatorImageUrl.trim();
    if (value) {
      let imageUrl: URL;
      try { imageUrl = new URL(value); } catch { throw new HTTPException(400, { message: "圖片網址格式不正確。" }); }
      if (imageUrl.protocol !== "https:" || !imageUrl.hostname || imageUrl.username || imageUrl.password) throw new HTTPException(400, { message: "圖片網址僅支援不含帳密的 HTTPS 網址。" });
      fields.storeLocatorImageUrl = imageUrl.toString();
    } else fields.storeLocatorImageUrl = "";
  }
  if (fields.storeLocatorImageId && fields.storeLocatorImageUrl) throw new HTTPException(400, { message: "圖片只能選擇媒體庫或圖片網址其中一種來源。" });
  if ("storeLocatorImageId" in input || "storeLocatorImageUrl" in input) {
    if (fields.storeLocatorImageUrl) fields.storeLocatorImageId = null;
    else fields.storeLocatorImageUrl = "";
  }
  if (fields.storeLocatorMapUrl) {
    let mapUrl: URL;
    try { mapUrl = new URL(fields.storeLocatorMapUrl); } catch { throw new HTTPException(400, { message: "地圖連結格式不正確。" }); }
    if (mapUrl.protocol !== "https:" || !["www.google.com", "maps.google.com", "maps.app.goo.gl"].includes(mapUrl.hostname)) {
      throw new HTTPException(400, { message: "地圖連結僅支援 Google Maps HTTPS 連結。" });
    }
    fields.storeLocatorMapUrl = mapUrl.toString();
  }
  for (const key of ["storeLocatorPinX", "storeLocatorPinY"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new HTTPException(400, { message: "地圖圖釘座標格式不正確。" });
    const bounds = key === "storeLocatorPinX" ? STORE_LOCATOR_PIN_BOUNDS.x : STORE_LOCATOR_PIN_BOUNDS.y;
    if (typeof value === "number" && (value < bounds.min || value > bounds.max)) {
      throw new HTTPException(400, { message: "地圖圖釘座標超出 SVG 地圖範圍。" });
    }
    fields[key] = value as number | null;
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
  const platform = typeof input.sourceType === "string" ? input.sourceType.trim().toLowerCase() : "cyberbiz";
  if (!isReportPlatform(platform)) throw new HTTPException(400, { message: "平台必須是有效的報表來源。" });
  if (!requested) return reportManagementScopeIdFromName(name, platform);
  if (!isValidScopeId(requested)) throw new HTTPException(400, { message: "通路 ID 含有不允許的字元。" });
  const idPlatform = requested.startsWith("shopee:")
    ? "shopee"
    : requested.startsWith("momo:")
      ? "momo"
      : requested.startsWith("manual:") || requested.startsWith("cyberbiz:") ? "cyberbiz" : "";
  if (idPlatform !== platform) throw new HTTPException(400, { message: "通路 ID 與平台不一致。" });
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
