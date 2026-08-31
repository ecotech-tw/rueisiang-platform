import {
  addProductSkuMapping,
  addReportSkuIgnore,
  deletePayoutStore,
  deleteProductSkuMapping,
  deleteReportSkuIgnore,
  listCyberbizProducts,
  listReportSkuIgnores,
  loadProductSkuMappingManagement,
  updateProductSkuMapping,
  insertReportPayoutDaily,
  isCompanyReportStoreScopeId,
  listReportScopes,
  recordCyberbizReportRun,
  listPayoutRuns,
  listPayoutStores,
  recordPayoutRun,
  replacePayoutStores,
  upsertReportScope,
  savePayoutStore,
  updatePayoutStoreEnabled,
  type PayoutStoreInput,
  type ProductBundleComponentInput,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { payoutGithub } from "../payout/github.js";
import { body, requireString } from "../request.js";

/** 只取字串欄位；沒帶就是 undefined（代表「這次不動它」），不是空字串。 */
function text(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * 組合用料。每一列是 WMS 商品或自訂 SKU，恰有一種——哪一種由 packages/db 判定，
 * 這裡只負責把 JSON 攤成型別對的形狀。
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
    return {
      inventoryItemId: typeof component.inventoryItemId === "string" ? component.inventoryItemId : null,
      cyberbizSku: typeof component.cyberbizSku === "string" ? component.cyberbizSku : null,
      customSku: typeof component.customSku === "string" ? component.customSku : null,
      customName: typeof component.customName === "string" ? component.customName : null,
      customCategory: typeof component.customCategory === "string" ? component.customCategory : null,
      quantity,
    };
  });
}

import { cyberbizScopeIdFromStoreName, manualScopeIdFromStoreName } from "../cyberbiz-scope.js";
import { cyberbizSalesGithub } from "../cyberbiz-sales/github.js";
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

function readStores(input: Record<string, unknown>): PayoutStoreInput[] {
  if (!Array.isArray(input.stores)) {
    throw new HTTPException(400, { message: "請提供店別清單。" });
  }

  const seen = new Set<string>();
  return input.stores.map((raw, index) => {
    const store = (raw ?? {}) as Record<string, unknown>;
    const name = typeof store.name === "string" ? store.name.trim() : "";
    if (!name) throw new HTTPException(400, { message: `第 ${index + 1} 家店沒有填店名。` });
    if (seen.has(name)) throw new HTTPException(400, { message: `店名重複：${name}` });
    seen.add(name);

    const url = typeof store.driveFolderUrl === "string" ? store.driveFolderUrl.trim() : "";
    // 空的允許（還沒建資料夾），但填了就要真的是 Drive 資料夾連結——
    // 貼錯連結會讓整批檔案上傳到別的地方，跑完才發現就來不及了。
    if (url && !/^https?:\/\/[^\s]*(\/folders\/[\w-]+|[?&]id=[\w-]+)/.test(url)) {
      throw new HTTPException(400, { message: `${name} 的 Google Drive 資料夾連結格式不正確。` });
    }
    const enabled = store.enabled === undefined ? true : store.enabled;
    if (typeof enabled !== "boolean") {
      throw new HTTPException(400, { message: `${name} 的顯示開關格式不正確。` });
    }

    return {
      name,
      driveFolderUrl: url,
      driveFolderName: typeof store.driveFolderName === "string" ? store.driveFolderName.trim() : "",
      enabled,
    };
  });
}

function readStore(input: Record<string, unknown>): PayoutStoreInput {
  const [store] = readStores({ stores: [input] });
  return store!;
}

function runnerStores(stores: PayoutStoreInput[]) {
  return stores.map(({ name, driveFolderUrl, driveFolderName }) => ({
    name,
    driveFolderUrl,
    driveFolderName,
  }));
}

async function syncPayoutStores(
  env: AppEnv["Bindings"],
  email: string,
  stores: PayoutStoreInput[],
): Promise<{ syncedToRepo: boolean; committed: boolean }> {
  const configuredStores = runnerStores(stores);
  const github = payoutGithub(env);
  let pushed = false;
  if (github) {
    pushed = await github.pushStores({
      stores: configuredStores,
      message: `chore(payout): 從平台更新店別清單（${email}）`,
    });
  }

  const salesGithub = cyberbizSalesGithub(env);
  let salesPushed = false;
  if (salesGithub) {
    salesPushed = await salesGithub.pushStores({
      stores: configuredStores,
      message: `chore(cyberbiz-sales): 從平台更新店別清單（${email}）`,
    });
  }

  return {
    syncedToRepo: Boolean(github || salesGithub),
    committed: pushed || salesPushed,
  };
}

function assertStoreNameAvailable(
  stores: Array<{ id: string; name: string }>,
  candidate: PayoutStoreInput,
  id?: string,
): void {
  if (stores.some((store) => store.id !== id && store.name === candidate.name)) {
    throw new HTTPException(400, { message: `店名重複：${candidate.name}` });
  }
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
    const scopes = (await listReportScopes(c.get("db"), "store"))
      .filter((scope) => isCompanyReportStoreScopeId(scope.id));
    return c.json({ scopes: scopes.map((scope) => ({ id: scope.id, name: scope.name })) });
  })

  .post("/manual-payout", requirePermission("tools:payout:config"), async (c) => {
    const input = await body(c);
    const scopeName = requireString(input, "scopeName", "據點名稱");
    // 既有據點沿用它的 ID，才不會讓同一家店的歷史被拆成兩個 scope。
    const requestedScopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
    const scopeId = requestedScopeId && isCompanyReportStoreScopeId(requestedScopeId)
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

    const scope = await upsertReportScope(c.get("db"), { id: scopeId, scopeKind: "store", name: scopeName });
    await insertReportPayoutDaily(c.get("db"), dailyRows);
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

  /** SKU 對應只服務報表匯入，跟倉位、盤點、庫存數量無關，所以掛在營運工具而不是倉儲。 */
  .get("/product-sku-mappings", requirePermission("tools:sku-mapping:read"), async (c) => {
    return c.json(await loadProductSkuMappingManagement(c.get("db")));
  })

  /** 建立一筆通路商品 mapping；至少要有一個 WMS 用料，單品也以 quantity=1 保存。 */
  .post("/product-sku-mappings", requirePermission("tools:sku-mapping:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await addProductSkuMapping(c.get("db"), {
      components: bundleComponents(input),
      channel: input.channel === undefined ? undefined : requireString(input, "channel", "通路"),
      externalName: requireString(input, "externalName", "通路商品名稱"),
      externalSku: requireString(input, "externalSku", "外部 SKU"),
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .patch("/product-sku-mappings/:mappingId", requirePermission("tools:sku-mapping:write"), async (c) => {
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
    return c.json(result);
  })

  /** SKU 對應頁挑用料用的 CYBERBIZ 商品清單（讀 D1 鏡像，不打官網）。 */
  .get("/cyberbiz-products", requirePermission("tools:sku-mapping:read"), async (c) => {
    return c.json({ products: await listCyberbizProducts(c.get("db")) });
  })

  /**
   * 刻意不納入報表的外部 SKU。
   *
   * 與「還沒建對應」在匯入端行為相同（都略過），差別只在要不要提醒——標記過的不再吵。
   */
  .get("/report-sku-ignores", requirePermission("tools:sku-mapping:read"), async (c) => {
    return c.json({ ignores: await listReportSkuIgnores(c.get("db")) });
  })

  .post("/report-sku-ignores", requirePermission("tools:sku-mapping:write"), async (c) => {
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

  .delete("/report-sku-ignores/:id", requirePermission("tools:sku-mapping:write"), async (c) => {
    const user = c.get("user");
    await deleteReportSkuIgnore(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  .delete("/product-sku-mappings/:mappingId", requirePermission("tools:sku-mapping:write"), async (c) => {
    const user = c.get("user");
    await deleteProductSkuMapping(c.get("db"), c.req.param("mappingId"), { id: user.id, email: user.email });
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
        scopeId: cyberbizScopeIdFromStoreName(store.name),
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
    await github.dispatch({ store, start, end, requestId });

    // 先觸發再記錄：GitHub 沒收下的話，這裡不該留下一筆看起來跑過的紀錄。
    const user = c.get("user");
    await recordPayoutRun(c.get("db"), {
      requestId,
      stores: requested,
      startDate: start,
      endDate: end,
      actor: { id: user.id, email: user.email },
    });
    await recordCyberbizReportRun(c.get("db"), {
      requestId,
      reportKind: "payout",
      periodKind: isCompleteMonth(start, end) ? "month" : "custom",
      stores: requested,
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

  /** 設定頁。讀要 config 權限——能改的人才需要看到 Drive 連結。 */
  .get("/payout/stores", requirePermission("tools:payout:config"), async (c) => {
    return c.json({ stores: await listPayoutStores(c.get("db")) });
  })

  .post("/payout/stores", requirePermission("tools:payout:config"), async (c) => {
    const input = readStore(await body(c));
    const currentStores = await listPayoutStores(c.get("db"));
    assertStoreNameAvailable(currentStores, input);

    const sync = await syncPayoutStores(c.env, c.get("user").email, [...currentStores, input]);
    const store = await savePayoutStore(c.get("db"), input);
    if (!store) throw new HTTPException(500, { message: "新增店別失敗，請稍後再試。" });
    return c.json({ store, ...sync }, 201);
  })

  .patch("/payout/stores/:id", requirePermission("tools:payout:config"), async (c) => {
    const id = c.req.param("id");
    const currentStores = await listPayoutStores(c.get("db"));
    const current = currentStores.find((store) => store.id === id);
    if (!current) throw new HTTPException(404, { message: "找不到這家店。" });

    const input = await body(c);
    const hasStoreDetails = ["name", "driveFolderUrl", "driveFolderName"].some((field) => field in input);
    if (!hasStoreDetails) {
      if (typeof input.enabled !== "boolean") {
        throw new HTTPException(400, { message: "店別顯示開關必須是布林值。" });
      }
      const store = await updatePayoutStoreEnabled(c.get("db"), { id, enabled: input.enabled });
      if (!store) throw new HTTPException(404, { message: "找不到這家店。" });
      return c.json({ store, syncedToRepo: false, committed: false });
    }

    const next = readStore({
      name: "name" in input ? input.name : current.name,
      driveFolderUrl: "driveFolderUrl" in input ? input.driveFolderUrl : current.driveFolderUrl,
      driveFolderName: "driveFolderName" in input ? input.driveFolderName : current.driveFolderName,
      enabled: "enabled" in input ? input.enabled : current.enabled,
    });
    assertStoreNameAvailable(currentStores, next, id);

    const nextStores = currentStores.map((store) => store.id === id ? next : store);
    const sync = await syncPayoutStores(c.env, c.get("user").email, nextStores);
    const store = await savePayoutStore(c.get("db"), { id, ...next });
    if (!store) throw new HTTPException(404, { message: "找不到這家店。" });
    return c.json({ store, ...sync });
  })

  .delete("/payout/stores/:id", requirePermission("tools:payout:config"), async (c) => {
    const id = c.req.param("id");
    const currentStores = await listPayoutStores(c.get("db"));
    if (!currentStores.some((store) => store.id === id)) {
      throw new HTTPException(404, { message: "找不到這家店。" });
    }
    if (currentStores.length === 1) {
      throw new HTTPException(400, { message: "至少要留一家店。" });
    }

    const nextStores = currentStores.filter((store) => store.id !== id);
    const sync = await syncPayoutStores(c.env, c.get("user").email, nextStores);
    const store = await deletePayoutStore(c.get("db"), id);
    if (!store) throw new HTTPException(404, { message: "找不到這家店。" });
    return c.json({ ok: true, ...sync });
  })

  /**
   * 存店別。
   *
   * 先寫帳務 repo 的 stores.json，成功了才寫本地——跟客戶那邊「先寫官網再寫本地」
   * 同一個道理。反過來的話，平台上看起來改好了，driver 讀到的還是舊的，執行時
   * 才發現找不到資料夾。
   *
   * 沒設定 GitHub token 時仍然存本地，但要明講 repo 沒更新，讓人知道還得自己
   * 把檔案補上去。
   */
  .put("/payout/stores", requirePermission("tools:payout:config"), async (c) => {
    const stores = readStores(await body(c));
    if (!stores.length) throw new HTTPException(400, { message: "至少要留一家店。" });

    const sync = await syncPayoutStores(c.env, c.get("user").email, stores);

    await replacePayoutStores(c.get("db"), stores);
    return c.json({
      stores: await listPayoutStores(c.get("db")),
      ...sync,
    });
  });
