import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, customers, userRoles, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function seedCustomer(id: string, name: string, phone: string) {
  await db().insert(customers).values({ id, name, phone, normalizedPhone: phone });
}

async function seedEvent(input: {
  id: string;
  customerId: string;
  /** 紀錄裡存的客戶名快照。搜尋姓名時比對的是它，不是 customers.name。 */
  customerName?: string;
  summary: string;
  source?: string;
  actorEmail?: string;
  createdAt: string;
}) {
  await db().insert(activityEvents).values({
    id: input.id,
    // 這一頁只看客戶那一種；WMS 的紀錄寫在同一張表，不標 entityType 會混進來。
    entityType: "customer",
    entityId: input.customerId,
    entityLabel: input.customerName ?? "",
    eventType: "customer_updated",
    summary: input.summary,
    source: input.source ?? "crm",
    actorType: input.actorEmail ? "user" : "system",
    actorEmail: input.actorEmail ?? null,
    createdAt: input.createdAt,
  });
}

async function list(userId: string, email: string, query = "") {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  const response = await app.fetch(
    new Request(`https://platform.rueisiang.com/api/crm/events${query}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }),
    env as never,
  );
  return response;
}

async function body(userId: string, email: string, query = "") {
  const response = await list(userId, email, query);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    events: { id: string; summary: string; customerName: string; source: string }[];
    page: number;
    hasMore: boolean;
  };
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
  await seedCustomer("c1", "王小明", "0912345678");
  await seedCustomer("c2", "陳美玲", "0922333444");
});

describe("操作紀錄的把關", () => {
  it("未登入是 401", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/crm/events"),
      env as never,
    );
    expect(response.status).toBe(401);
  });

  it("沒有 crm:activity:read 的人被擋下", async () => {
    const id = "user-none@ecotech.tw";
    await db().insert(users).values({ id, email: "none@ecotech.tw", status: "active" });
    expect((await list(id, "none@ecotech.tw")).status).toBe(403);
  });

  it("檢視者讀得到——這是唯讀端點", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    expect((await list(id, "viewer@ecotech.tw")).status).toBe(200);
  });
});

describe("列表內容", () => {
  beforeEach(async () => {
    await seedEvent({ id: "e1", customerId: "c1", customerName: "王小明", summary: "由 CYBERBIZ webhook 更新", source: "cyberbiz_webhook", createdAt: "2026-08-01 10:00:00" });
    await seedEvent({ id: "e2", customerId: "c2", customerName: "陳美玲", summary: "有人手動編輯", actorEmail: "staff@ecotech.tw", createdAt: "2026-08-02 10:00:00" });
    await seedEvent({ id: "e3", customerId: "c1", customerName: "王小明", summary: "重新讀取 CYBERBIZ 資料", source: "cyberbiz_sync", createdAt: "2026-08-03 10:00:00" });
  });

  it("最新的排在最前面", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw");
    expect(result.events.map((event) => event.id)).toEqual(["e3", "e2", "e1"]);
  });

  /*
   * 姓名現在讀 entityLabel（寫入當下的快照），不是 join customers。
   * 客戶改名或被刪掉之後，這一頁仍然顯示「當時」的名字——那才是稽核要的。
   */
  it("帶出客戶的姓名，不必再查一次", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw");
    // 由新到舊是 e3、e2、e1。
    expect(result.events.map((event) => event.customerName)).toEqual(["王小明", "陳美玲", "王小明"]);
  });

  it("依來源篩選", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw", "?source=cyberbiz_webhook");
    expect(result.events.map((event) => event.id)).toEqual(["e1"]);
  });

  it.each([
    ["客戶姓名", "?search=陳美玲", ["e2"]],
    ["客戶電話", "?search=0912345", ["e3", "e1"]],
    ["摘要", "?search=手動編輯", ["e2"]],
    ["操作者", "?search=staff@ecotech.tw", ["e2"]],
  ])("搜尋涵蓋%s", async (_label, query, expected) => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw", query);
    expect(result.events.map((event) => event.id)).toEqual(expected);
  });
});

describe("分頁", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 30; i += 1) {
      await seedEvent({
        id: `e${String(i).padStart(2, "0")}`,
        customerId: "c1",
        summary: `第 ${i} 筆`,
        createdAt: `2026-08-01 10:${String(i).padStart(2, "0")}:00`,
      });
    }
  });

  it("預設每頁 25 筆並回報還有下一頁", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw");

    // 多抓一筆判斷有沒有下一頁，不做全表 count——紀錄會長到幾十萬筆。
    expect(result.events).toHaveLength(25);
    expect(result.hasMore).toBe(true);
  });

  it("最後一頁的 hasMore 是 false", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw", "?page=2");

    expect(result.events).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });

  it("每頁筆數不在白名單時退回預設", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const result = await body(id, "staff@ecotech.tw", "?pageSize=999");
    expect(result.events).toHaveLength(25);
  });
});
