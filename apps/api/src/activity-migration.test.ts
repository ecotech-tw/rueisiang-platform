import { createDatabase } from "@rueisiang/db";
import { activityEvents, customers } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * 稽核紀錄從 customer_events 搬到 activity_events。
 *
 * 這條路只跑一次，但跑錯的代價是正式站上的歷史紀錄全部消失，而且不可逆——
 * 所以值得一個測試。
 *
 * 手法是「回到搬移前的狀態」：D1 的 migration 依檔名排序套用，所以測試裡自己
 * 建一張 customer_events、塞資料，再把 0008 那段 SQL 跑一次，看有沒有搬過去。
 */

const MOVE_SQL = `
INSERT INTO activity_events (
  id, entity_type, entity_id, entity_label, event_type, summary,
  field, old_value, new_value, payload_json,
  actor_type, actor_id, actor_email, source, status, error, created_at
)
SELECT
  e.id, 'customer', e.customer_id, COALESCE(c.name, ''), e.event_type, e.summary,
  '', NULL, NULL, e.payload_json,
  e.actor_type, e.actor_id, e.actor_email, e.source, e.status, e.error, e.created_at
FROM customer_events e
LEFT JOIN customers c ON c.id = e.customer_id;
`;

/** 重建搬移前的那張表。0009 已經把它刪掉了，測試要自己造回來。 */
const LEGACY_TABLE = `
CREATE TABLE customer_events (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}' NOT NULL,
  actor_type TEXT DEFAULT 'system' NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  source TEXT DEFAULT 'crm' NOT NULL,
  status TEXT DEFAULT 'succeeded' NOT NULL,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

describe("把 customer_events 搬進 activity_events", () => {
  async function migrate() {
    const d1 = createLocalD1();
    const db = createDatabase(d1 as never);

    await db.insert(customers).values({
      id: "cust-1",
      phone: "0900111222",
      normalizedPhone: "886900111222",
      name: "王小明",
    });

    d1.sqlite.exec(LEGACY_TABLE);
    d1.sqlite.exec(`
      INSERT INTO customer_events
        (id, customer_id, event_type, summary, payload_json, actor_type, actor_id, actor_email, source, status, created_at)
      VALUES
        ('evt-1', 'cust-1', 'customer_updated', '編輯客戶資料', '{"changedFields":["name"]}',
         'user', 'user-1', 'eli-lin@ecotech.tw', 'crm', 'succeeded', '2026-08-01 10:00:00'),
        ('evt-2', 'gone', 'customer_blocked', '封鎖客戶', '{}',
         'system', NULL, NULL, 'cyberbiz_sync', 'succeeded', '2026-08-02 10:00:00');
    `);

    d1.sqlite.exec(MOVE_SQL);
    return db;
  }

  it("兩筆都搬過去，一筆都沒漏", async () => {
    const db = await migrate();
    const rows = await db.select().from(activityEvents);
    expect(rows).toHaveLength(2);
  });

  it("欄位對應正確，entityType 一律是 customer", async () => {
    const db = await migrate();
    const [row] = await db.select().from(activityEvents).where(eq(activityEvents.id, "evt-1"));

    expect(row).toMatchObject({
      entityType: "customer",
      entityId: "cust-1",
      entityLabel: "王小明",
      eventType: "customer_updated",
      summary: "編輯客戶資料",
      payloadJson: '{"changedFields":["name"]}',
      actorType: "user",
      actorEmail: "eli-lin@ecotech.tw",
      source: "crm",
      createdAt: "2026-08-01 10:00:00",
    });
  });

  it("CRM 沒有欄位級的新舊值，那三欄留空", async () => {
    const db = await migrate();
    const [row] = await db.select().from(activityEvents).where(eq(activityEvents.id, "evt-1"));

    expect(row?.field).toBe("");
    expect(row?.oldValue).toBeNull();
    expect(row?.newValue).toBeNull();
  });

  /*
   * 客戶已經被刪掉的紀錄不能因為 join 不到就整筆消失——舊表用 innerJoin 查詢，
   * 那些紀錄本來就看不到了，但資料還在，搬移時要一起帶走。
   */
  it("客戶已經不在的紀錄也要搬過去，名字留空", async () => {
    const db = await migrate();
    const [row] = await db.select().from(activityEvents).where(eq(activityEvents.id, "evt-2"));

    expect(row?.entityId).toBe("gone");
    expect(row?.entityLabel).toBe("");
    expect(row?.source).toBe("cyberbiz_sync");
  });
});
