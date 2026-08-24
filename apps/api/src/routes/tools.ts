import {
  listPayoutRuns,
  listPayoutStores,
  recordPayoutRun,
  replacePayoutStores,
  type PayoutStoreInput,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { payoutGithub } from "../payout/github.js";
import { body } from "../request.js";
import { shopeeSales } from "./shopee-sales.js";

/**
 * 營運工具。目前只有出金表。
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

    return {
      name,
      driveFolderUrl: url,
      driveFolderName: typeof store.driveFolderName === "string" ? store.driveFolderName.trim() : "",
    };
  });
}

export const tools = new Hono<AppEnv>()
  .use("*", requireAuth)
  .route("/shopee-sales", shopeeSales)

  /** 執行頁一開始要的東西：店別、預設區間、以及後端到底有沒有接上 GitHub。 */
  .get("/payout/state", requirePermission("tools:payout:run"), async (c) => {
    const stores = await listPayoutStores(c.get("db"));
    const range = previousMonthRange();
    const runs = await listPayoutRuns(c.get("db"), 10);
    return c.json({
      stores: stores.map((store) => ({
        name: store.name,
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

    const known = (await listPayoutStores(c.get("db"))).map((store) => store.name);
    const unknown = requested.filter((name) => !known.includes(name));
    if (unknown.length) throw new HTTPException(400, { message: `不認得的通路：${unknown.join("、")}` });

    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    if (!isValidDate(start) || !isValidDate(end)) {
      throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
    }
    if (start > end) throw new HTTPException(400, { message: "起日不能晚於迄日。" });

    /*
     * workflow 的 store 輸入只吃「全部」或單一店名。這是帳務 repo 那邊的限制，
     * 搬過來不改——真要改是改 workflow，不是在這裡拼字串矇混過去。
     */
    const isAll = requested.length === known.length && known.every((name) => requested.includes(name));
    if (!isAll && requested.length !== 1) {
      throw new HTTPException(400, { message: "一次只能選一家店或全部店別。" });
    }
    const store = isAll ? "全部" : requested[0]!;

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

    const github = payoutGithub(c.env);
    let pushed = false;
    if (github) {
      pushed = await github.pushStores({
        stores,
        message: `chore(payout): 從平台更新店別清單（${c.get("user").email}）`,
      });
    }

    await replacePayoutStores(c.get("db"), stores);
    return c.json({
      stores: await listPayoutStores(c.get("db")),
      // pushed=false 有兩種可能：沒接 GitHub，或內容根本沒變。前端要分得出來。
      syncedToRepo: Boolean(github),
      committed: pushed,
    });
  });
