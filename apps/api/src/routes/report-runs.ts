import { listReportRuns, type ReportRunKind } from "@rueisiang/db";
import { can } from "@rueisiang/auth";
import type { Permission } from "@rueisiang/auth/permissions";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";

/**
 * 四種報表執行的共用紀錄。
 *
 * **每一種報表看自己的權限。** 沒有另開一個「看紀錄」的鍵，因為這一頁只是把四個
 * 執行頁本來各自顯示的「最近執行」放在一起看；但也不能因為有其中一種權限就全部
 * 給——只有出金表權限的人不該看得到官網與蝦皮跑過哪些區間、誰按的。
 */
const KIND_PERMISSIONS: Record<ReportRunKind, Permission> = {
  "cyberbiz-payout": "tools:payout:run",
  "cyberbiz-sales": "tools:cyberbiz-sales:run",
  "cyberbiz-shop": "tools:shop-report:run",
  shopee: "tools:shopee-sales:run",
};

function allowedKinds(user: Parameters<typeof can>[0]): ReportRunKind[] {
  return (Object.keys(KIND_PERMISSIONS) as ReportRunKind[])
    .filter((kind) => can(user, KIND_PERMISSIONS[kind]));
}

export const reportRuns = new Hono<AppEnv>()
  .get("/", async (c) => {
    const allowed = allowedKinds(c.get("user"));
    if (!allowed.length) throw new HTTPException(403, { message: "需要任一種報表執行權限。" });

    const requested = c.req.query("kind");
    if (requested && !(requested in KIND_PERMISSIONS)) {
      throw new HTTPException(400, { message: `不認得的報表種類：${requested}` });
    }
    // 指定了沒有權限的那一種就是 403，不要默默回空清單——那會讓人以為真的沒跑過。
    if (requested && !allowed.includes(requested as ReportRunKind)) {
      throw new HTTPException(403, { message: "沒有這種報表的執行權限。" });
    }

    return c.json({
      runs: await listReportRuns(c.get("db"), {
        kinds: requested ? [requested as ReportRunKind] : allowed,
        limit: 50,
      }),
    });
  });
