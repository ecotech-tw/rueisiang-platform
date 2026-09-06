import { createDatabase, purgeSettledWebhookEvents, WEBHOOK_EVENT_RETENTION_DAYS } from "@rueisiang/db";
import { cyberbizWebhookEvents } from "@rueisiang/db/schema";
import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

let d1: ReturnType<typeof createTargetOnlyD1>;
let db: ReturnType<typeof createDatabase>;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
});

async function seed(rows: Array<{ id: string; status: string; days: number }>) {
  await db.insert(cyberbizWebhookEvents).values(rows.map((row) => ({
    id: row.id,
    topic: "customers/update",
    status: row.status,
    payloadJson: "{}",
    receivedAt: daysAgo(row.days),
  })));
}

async function remaining() {
  const rows = await db.select({ id: cyberbizWebhookEvents.id }).from(cyberbizWebhookEvents)
    .orderBy(asc(cyberbizWebhookEvents.id));
  return rows.map((row) => row.id);
}

describe("webhook 事件保留期", () => {
  it("只清掉過期而且已經處理完的", async () => {
    await seed([
      { id: "old-processed", status: "processed", days: 60 },
      { id: "old-ignored", status: "ignored", days: 60 },
      { id: "new-processed", status: "processed", days: 1 },
    ]);

    expect(await purgeSettledWebhookEvents(db)).toEqual({ deleted: 2 });
    expect(await remaining()).toEqual(["new-processed"]);
  });

  it("失敗與處理中的一律留著，再舊都不刪", async () => {
    await seed([
      { id: "old-failed", status: "failed", days: 400 },
      { id: "old-processing", status: "processing", days: 400 },
    ]);

    expect(await purgeSettledWebhookEvents(db)).toEqual({ deleted: 0 });
    expect(await remaining()).toEqual(["old-failed", "old-processing"]);
  });

  it("沒有東西可清就不動作", async () => {
    expect(await purgeSettledWebhookEvents(db)).toEqual({ deleted: 0 });
  });

  it("超過一批（100 筆）也刪得完——D1 對單一語句的參數量有上限", async () => {
    await seed(Array.from({ length: 250 }, (_, index) => ({
      id: `old-${String(index).padStart(3, "0")}`, status: "processed", days: 60,
    })));

    expect(await purgeSettledWebhookEvents(db)).toEqual({ deleted: 250 });
    expect(await remaining()).toEqual([]);
  });

  it("保留天數可以覆寫", async () => {
    await seed([{ id: "five-days", status: "processed", days: 5 }]);

    expect(await purgeSettledWebhookEvents(db, { retentionDays: 3 })).toEqual({ deleted: 1 });
    expect(WEBHOOK_EVENT_RETENTION_DAYS).toBe(30);
  });
});
