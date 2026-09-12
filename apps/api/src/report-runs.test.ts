import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listReportRuns, syncSystemRoles, upsertReportScope } from "@rueisiang/db";
import { reportRunScopes, reportRuns, userRoleAssignments, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

/*
 * 四種報表的共用執行紀錄。以前每個執行頁各自撈自己的，靠 request_id 前綴互相排擠；
 * 這裡守的是那套排擠規則換成一個 kind 之後，每一種還是各自分得清楚。
 */

const SECRET = "test-secret";
let d1: ReturnType<typeof createTargetOnlyD1>;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }), SECRET);
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } }),
    env as never,
  );
}

async function seedRun(input: {
  id: string;
  requestId: string;
  sourceType: string;
  importsSales: number;
  importsPayout: number;
  scopeIds?: string[];
  actorEmail?: string;
  createdAt: string;
}) {
  await db().insert(reportRuns).values({
    id: input.id,
    requestId: input.requestId,
    sourceType: input.sourceType,
    importsSales: input.importsSales,
    importsPayout: input.importsPayout,
    periodKind: "month",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    status: "queued",
    actorEmail: input.actorEmail ?? "manager@ecotech.tw",
    createdAt: input.createdAt,
  });
  for (const scopeId of input.scopeIds ?? []) {
    await db().insert(reportRunScopes).values({ reportRunId: input.id, scopeId });
  }
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  env = { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "c", GOOGLE_OAUTH_CLIENT_SECRET: "s" };
  await syncSystemRoles(db());
  await upsertReportScope(db(), { id: "cyberbiz:store:a", scopeKind: "store", name: "甲店" });
  await upsertReportScope(db(), { id: "cyberbiz:channel:shop", scopeKind: "channel", name: "官網" });
  await upsertReportScope(db(), { id: "shopee:store:default", scopeKind: "store", sourceType: "shopee", name: "蝦皮" });
});

describe("報表執行紀錄", () => {
  it("四種報表各自分得出來，官網不會被算成商品銷售或出金", async () => {
    // 官網兩個旗標都是 1，所以種類判斷一定要先認出它，否則會同時落進另外兩類。
    await seedRun({ id: "r1", requestId: "a", sourceType: "cyberbiz", importsSales: 0, importsPayout: 1, scopeIds: ["cyberbiz:store:a"], createdAt: "2026-09-01 01:00:00" });
    await seedRun({ id: "r2", requestId: "b", sourceType: "cyberbiz", importsSales: 1, importsPayout: 0, scopeIds: ["cyberbiz:store:a"], createdAt: "2026-09-01 02:00:00" });
    await seedRun({ id: "r3", requestId: "shop:c", sourceType: "cyberbiz", importsSales: 1, importsPayout: 1, scopeIds: ["cyberbiz:channel:shop"], createdAt: "2026-09-01 03:00:00" });
    await seedRun({ id: "r4", requestId: "d", sourceType: "shopee", importsSales: 1, importsPayout: 1, scopeIds: ["shopee:store:default"], createdAt: "2026-09-01 04:00:00" });

    const runs = await listReportRuns(db());
    expect(runs.map((run) => [run.id, run.kind])).toEqual([
      ["r4", "shopee"],
      ["r3", "cyberbiz-shop"],
      ["r2", "cyberbiz-sales"],
      ["r1", "cyberbiz-payout"],
    ]);

    expect((await listReportRuns(db(), { kinds: ["cyberbiz-shop"] })).map((run) => run.id)).toEqual(["r3"]);
    expect((await listReportRuns(db(), { kinds: ["cyberbiz-payout"] })).map((run) => run.id)).toEqual(["r1"]);
  });

  it("匯入自己建的 run 與沒有執行人的 run 都不列出來", async () => {
    // 那些 request_id 不存在於 GitHub 的 run-name，當成「最近執行」會對不到工作流程。
    await seedRun({ id: "r1", requestId: "cyberbiz-ingest:x", sourceType: "cyberbiz", importsSales: 1, importsPayout: 0, createdAt: "2026-09-01 01:00:00" });
    await seedRun({ id: "r2", requestId: "target-import:x", sourceType: "cyberbiz", importsSales: 1, importsPayout: 0, createdAt: "2026-09-01 02:00:00" });
    await seedRun({ id: "r3", requestId: "real", sourceType: "cyberbiz", importsSales: 1, importsPayout: 0, actorEmail: "", createdAt: "2026-09-01 03:00:00" });

    expect(await listReportRuns(db())).toEqual([]);
  });

  it("多個通路回傳名稱陣列，店名含逗號也不會被切開", async () => {
    await upsertReportScope(db(), { id: "cyberbiz:store:b", scopeKind: "store", name: "乙店, 二館" });
    await seedRun({ id: "r1", requestId: "a", sourceType: "cyberbiz", importsSales: 0, importsPayout: 1, scopeIds: ["cyberbiz:store:a", "cyberbiz:store:b"], createdAt: "2026-09-01 01:00:00" });

    const [run] = await listReportRuns(db());
    expect(run!.scopeNames.sort()).toEqual(["乙店, 二館", "甲店"]);
  });

  it("有任一種執行權限就讀得到，都沒有的話 403", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const staff = await seedUser("staff@ecotech.tw", "role-staff");

    expect((await as(manager, "manager@ecotech.tw", "/api/tools/reports/runs")).status).toBe(200);
    expect((await as(staff, "staff@ecotech.tw", "/api/tools/reports/runs")).status).toBe(403);
  });

  it("不認得的種類回 400，不要當成沒篩選整批倒出來", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(manager, "manager@ecotech.tw", "/api/tools/reports/runs?kind=nope");
    expect(response.status).toBe(400);
  });
});
