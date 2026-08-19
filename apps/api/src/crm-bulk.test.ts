import type { CyberbizCustomer } from "@rueisiang/cyberbiz";
import { createDatabase, upsertCyberbizCustomers } from "@rueisiang/db";
import { customerEvents, customers } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 全量同步用的批次寫入。合併規則必須跟逐筆那條一致——舊系統就是因為兩套規則
 * 不一樣，同一筆客戶經過 webhook 與經過全量同步會得到不同結果。
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

async function row(externalId = "cb-1") {
  const [found] = await db().select().from(customers).where(eq(customers.cyberbizCustomerId, externalId));
  return found;
}

beforeEach(() => {
  d1 = createLocalD1();
});

describe("批次寫入", () => {
  it("整批寫進去並回報筆數", async () => {
    const summary = await upsertCyberbizCustomers(db(), [
      member({ externalId: "cb-1" }),
      member({ externalId: "cb-2" }),
    ]);

    expect(summary).toEqual({ received: 2, written: 2, skipped: 0 });
    expect(await db().select().from(customers)).toHaveLength(2);
  });

  it("沒有會員 ID 的略過，不會生出幽靈客戶", async () => {
    const summary = await upsertCyberbizCustomers(db(), [member(), member({ externalId: "" })]);

    expect(summary).toMatchObject({ received: 2, written: 1, skipped: 1 });
    expect(await db().select().from(customers)).toHaveLength(1);
  });

  it("重跑同一批不會產生重複客戶", async () => {
    const batch = [member({ externalId: "cb-1" }), member({ externalId: "cb-2" })];
    await upsertCyberbizCustomers(db(), batch);
    await upsertCyberbizCustomers(db(), batch);

    expect(await db().select().from(customers)).toHaveLength(2);
  });

  it("不寫操作紀錄——一次匯入上萬筆會把紀錄灌成雜訊", async () => {
    await upsertCyberbizCustomers(db(), [member()]);
    expect(await db().select().from(customerEvents)).toHaveLength(0);
  });
});

describe("批次的合併規則與逐筆一致", () => {
  beforeEach(async () => {
    await upsertCyberbizCustomers(db(), [member()]);
  });

  it("空值不覆蓋既有的姓名、Email、地址", async () => {
    // 舊系統的批次路徑是 name = excluded.name，官網清空就連本地一起洗掉。
    await upsertCyberbizCustomers(db(), [member({ name: "", email: "", address: "" })]);

    const found = await row();
    expect(found?.name).toBe("王小明");
    expect(found?.email).toBe("wang@example.com");
    expect(found?.address).toBe("台北市大安區");
  });

  it("電話仍然以官網為準，空值會清掉", async () => {
    await upsertCyberbizCustomers(db(), [member({ phone: "" })]);

    const found = await row();
    expect(found?.phone).toBe("");
    expect(found?.normalizedPhone).toBe("");
  });

  it("標籤是空陣列時保留既有標籤", async () => {
    await upsertCyberbizCustomers(db(), [member({ tags: [] })]);
    expect((await row())?.cyberbizTagsJson).toBe('["VIP"]');
  });

  it("人工建立的客戶不會被改成 cyberbiz 來源", async () => {
    await db()
      .update(customers)
      .set({ sourceChannel: "manual" })
      .where(eq(customers.cyberbizCustomerId, "cb-1"));

    await upsertCyberbizCustomers(db(), [member({ name: "官網名字" })]);

    const found = await row();
    expect(found?.sourceChannel).toBe("manual");
    expect(found?.name).toBe("官網名字");
  });

  it("官網解除封鎖不會自動解除本地封鎖", async () => {
    await upsertCyberbizCustomers(db(), [member({ blocked: true })]);
    expect((await row())?.status).toBe("blocked");

    await upsertCyberbizCustomers(db(), [member({ blocked: false })]);
    expect((await row())?.status).toBe("blocked");
  });

  it("同步狀態會被修回 synced，錯誤訊息清掉", async () => {
    await db()
      .update(customers)
      .set({ syncStatus: "failed", syncError: "上次失敗" })
      .where(eq(customers.cyberbizCustomerId, "cb-1"));

    await upsertCyberbizCustomers(db(), [member()]);

    const found = await row();
    expect(found?.syncStatus).toBe("synced");
    expect(found?.syncError).toBeNull();
  });
});
