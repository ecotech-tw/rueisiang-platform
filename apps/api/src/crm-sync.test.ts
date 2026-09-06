import type { CyberbizCustomer } from "@rueisiang/cyberbiz";
import { createDatabase, syncCyberbizCustomer, syncCyberbizCustomers } from "@rueisiang/db";
import { activityEvents, crmCustomerTags, crmTags, crmCustomers } from "@rueisiang/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 同步的合併規則。這裡不碰 HTTP，只驗「一筆 CYBERBIZ 會員進來之後
 * 本地資料變成什麼樣子」——那是最容易寫錯、也最難從畫面上看出來的部分。
 */

let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

function member(overrides: Partial<CyberbizCustomer> = {}): CyberbizCustomer {
  return {
    externalId: "cb-1",
    uid: "uid-1",
    phone: "0912345678",
    email: "wang@example.com",
    name: "王小明",
    address: "台北市大安區",
    tags: ["VIP"],
    blocked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    raw: { id: "cb-1" },
    ...overrides,
  };
}

async function rowByExternalId(externalId: string) {
  const [row] = await db().select().from(crmCustomers).where(eq(crmCustomers.cyberbizCustomerId, externalId));
  return row;
}

async function eventsFor(customerId: string) {
  // 紀錄現在用 entityType + entityId 定位，不再有 customerId 欄位。
  return db()
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "customer"), eq(activityEvents.entityId, customerId)));
}

beforeEach(() => {
  d1 = createLocalD1();
});

describe("第一次收到會員", () => {
  it("建立客戶並留下一筆紀錄", async () => {
    const result = await syncCyberbizCustomer(db(), member(), { topic: "customers/create" });
    expect(result.action).toBe("created");

    const row = await rowByExternalId("cb-1");
    expect(row).toMatchObject({
      name: "王小明",
      phone: "0912345678",
      normalizedPhone: "0912345678",
      cyberbizCustomerId: "cb-1",
      syncStatus: "synced",
      status: "active",
    });

    const events = await eventsFor(result.customerId!);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("cyberbiz_imported");
  });

  it("webhook 來的會標成 webhook 事件", async () => {
    const result = await syncCyberbizCustomer(db(), member(), { topic: "customers/create", eventId: "evt-1" });

    const events = await eventsFor(result.customerId!);
    expect(events[0]?.eventType).toBe("cyberbiz_webhook_created");
    expect(events[0]?.source).toBe("cyberbiz_webhook");
  });

  it("國碼會被正規化，之後搜尋才對得上", async () => {
    await syncCyberbizCustomer(db(), member({ phone: "+886912345678" }), { topic: "t" });
    expect((await rowByExternalId("cb-1"))?.normalizedPhone).toBe("0912345678");
  });

  it("官網封鎖的會員一進來就是封鎖狀態", async () => {
    await syncCyberbizCustomer(db(), member({ blocked: true }), { topic: "t" });
    const row = await rowByExternalId("cb-1");
    expect(row?.status).toBe("blocked");
    expect(row?.blockedAt).toBeTruthy();
  });
});

describe("沒有會員 ID 的事件", () => {
  it("不寫入，回 ignored 與原因", async () => {
    const result = await syncCyberbizCustomer(db(), member({ externalId: "" }), { topic: "t" });

    expect(result.action).toBe("ignored");
    expect(result.reason).toContain("沒有會員 ID");
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
  });
});

describe("再次收到同一個會員", () => {
  beforeEach(async () => {
    await syncCyberbizCustomer(db(), member(), { topic: "customers/create" });
  });

  it("內容沒變就不重複寫紀錄", async () => {
    const result = await syncCyberbizCustomer(db(), member(), { topic: "customers/update" });

    expect(result.action).toBe("unchanged");
    expect(await eventsFor(result.customerId!)).toHaveLength(1);
  });

  it("內容有變就更新並補一筆紀錄", async () => {
    const result = await syncCyberbizCustomer(
      db(),
      member({ name: "王大明", updatedAt: "2026-08-10T00:00:00.000Z" }),
      { topic: "customers/update" },
    );

    expect(result.action).toBe("updated");
    expect((await rowByExternalId("cb-1"))?.name).toBe("王大明");
    expect(await eventsFor(result.customerId!)).toHaveLength(2);
  });

  it("官網把姓名清空時不會洗掉本地的——空值不覆蓋", async () => {
    await syncCyberbizCustomer(db(), member({ name: "", email: "", address: "" }), { topic: "t" });

    const row = await rowByExternalId("cb-1");
    expect(row?.name).toBe("王小明");
    expect(row?.email).toBe("wang@example.com");
    expect(row?.address).toBe("台北市大安區");
  });

  it("但電話會被空值覆蓋——會員本人的 mobile 才算數", async () => {
    await syncCyberbizCustomer(db(), member({ phone: "" }), { topic: "t" });

    const row = await rowByExternalId("cb-1");
    expect(row?.phone).toBe("");
    expect(row?.normalizedPhone).toBe("");
  });

  it("標籤是空陣列時保留既有標籤", async () => {
    await syncCyberbizCustomer(db(), member({ tags: [] }), { topic: "t" });
    const customer = await rowByExternalId("cb-1");
    const tags = await db()
      .select({ name: crmTags.name })
      .from(crmCustomerTags)
      .innerJoin(crmTags, eq(crmTags.id, crmCustomerTags.crmTagId))
      .where(eq(crmCustomerTags.customerId, customer!.id));
    expect(tags.map((tag) => tag.name)).toEqual(["VIP"]);
  });

  it("官網解除封鎖不會自動解除本地的封鎖", async () => {
    await syncCyberbizCustomer(db(), member({ blocked: true }), { topic: "t" });
    expect((await rowByExternalId("cb-1"))?.status).toBe("blocked");

    await syncCyberbizCustomer(db(), member({ blocked: false, updatedAt: "2026-08-11T00:00:00.000Z" }), { topic: "t" });
    // 封鎖是店裡自己的決定，官網那邊解除不代表這邊要跟著解除。
    expect((await rowByExternalId("cb-1"))?.status).toBe("blocked");
  });
});

describe("以 CYBERBIZ 會員 ID 對應客戶", () => {
  it("以會員 ID 更新既有客戶", async () => {
    const id = "manual-1";
    await db().insert(crmCustomers).values({
      id,
      phone: "0912345678",
      normalizedPhone: "0912345678",
      name: "人工客戶",
      cyberbizCustomerId: "cb-1",
    });

    await syncCyberbizCustomer(db(), member({ name: "官網名字" }), { topic: "t" });

    const row = await rowByExternalId("cb-1");
    expect(row?.id).toBe(id);
    expect(row?.name).toBe("官網名字");
  });
});

describe("電話相同但會員不同", () => {
  it("視為兩個客戶——電話不是穩定的身分", async () => {
    await syncCyberbizCustomer(db(), member({ externalId: "cb-1" }), { topic: "t" });
    await syncCyberbizCustomer(db(), member({ externalId: "cb-2", name: "同電話的另一位" }), { topic: "t" });

    // 公司電話這種情況很常見，併成一筆等於把兩個人的資料混在一起。
    expect(await db().select().from(crmCustomers)).toHaveLength(2);
  });
});

describe("整批同步", () => {
  it("回報每一種結果的筆數", async () => {
    const summary = await syncCyberbizCustomers(
      db(),
      [
        member({ externalId: "cb-1" }),
        member({ externalId: "cb-2" }),
        member({ externalId: "" }),
      ],
      { topic: "initial-sync" },
    );

    expect(summary).toEqual({ received: 3, created: 2, updated: 0, unchanged: 0, ignored: 1 });
  });

  it("重跑同一批只會是 unchanged，不會產生重複客戶", async () => {
    const batch = [member({ externalId: "cb-1" }), member({ externalId: "cb-2" })];
    await syncCyberbizCustomers(db(), batch, { topic: "initial-sync" });
    const second = await syncCyberbizCustomers(db(), batch, { topic: "initial-sync" });

    expect(second).toMatchObject({ created: 0, unchanged: 2 });
    expect(await db().select().from(crmCustomers)).toHaveLength(2);
  });
});
