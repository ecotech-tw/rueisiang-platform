import { failShopReportRun, listShopReportRuns, recordShopReportRun, shopReportRequestId } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/auth.js";
import { body } from "../request.js";
import { shopReportGithub } from "../shop-report/github.js";

/**
 * 官網對帳單執行頁的後端。
 *
 * 跟出金表／商品銷售的差別只有一個：這裡收的是**月份範圍**，不是起訖日。對帳中心的
 * 期間是 CYBERBIZ 每半個月自己切的（1–15、16–月底），使用者選不了，只能挑月份；
 * driver 會把那幾個月裡每一期都抓下來。
 */
function isValidMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** 預設抓上一個月：對帳單要等 CYBERBIZ 出期，當月通常還沒結完。 */
function previousMonth(): string {
  const taipei = new Date(Date.now() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth();
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function requireMonth(input: Record<string, unknown>, field: string): string {
  const value = typeof input[field] === "string" ? (input[field] as string).trim() : "";
  if (!isValidMonth(value)) throw new HTTPException(400, { message: "月份格式必須是 YYYY-MM。" });
  return value;
}

export const shopReport = new Hono<AppEnv>()
  .get("/state", requirePermission("tools:shop-report:run"), async (c) => {
    const runs = await listShopReportRuns(c.get("db"), 10);
    const month = previousMonth();
    return c.json({
      defaultStartMonth: month,
      defaultEndMonth: month,
      // 沒設定 workflow 時要讓畫面說得出原因，而不是等按下去才報錯。
      configured: Boolean(shopReportGithub(c.env)),
      latestRequestId: runs[0]?.requestId ?? null,
      runs,
    });
  })
  .post("/run", requirePermission("tools:shop-report:run"), async (c) => {
    const github = shopReportGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定官網對帳單的 GitHub workflow，無法觸發執行。" });
    const input = await body(c);
    const startMonth = requireMonth(input, "startMonth");
    const endMonth = requireMonth(input, "endMonth");
    if (startMonth > endMonth) throw new HTTPException(400, { message: "開始月份不能晚於結束月份。" });

    /*
     * 先記錄再觸發。
     *
     * 反過來的話，dispatch 成功但寫入失敗時，workflow 已經在跑、而且會一路把資料
     * 寫進 D1，但「最近執行」是空的、latestRequestId 也接不回去——沒有人知道那次
     * 是誰按的、什麼時候按的。先寫再觸發則相反：觸發失敗時多一列沒跑成的紀錄，
     * 那是看得見也說得清的，所以把它標成 failed 就好。
     */
    const requestId = shopReportRequestId();
    const run = await recordShopReportRun(c.get("db"), {
      requestId,
      startMonth,
      endMonth,
      actor: c.get("user"),
    });
    try {
      await github.dispatch({ startMonth, endMonth, requestId });
    } catch (error) {
      await failShopReportRun(c.get("db"), requestId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return c.json({ requestId, run, startMonth, endMonth }, 202);
  })
  .get("/status", requirePermission("tools:shop-report:run"), async (c) => {
    const github = shopReportGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GitHub workflow。" });
    return c.json(await github.listRuns(c.req.query("requestId") ?? undefined));
  });
