import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizeCustomerQuery, type CustomerQuery } from "./crm.js";
import { crmSavedViews } from "./schema/crm.js";

/**
 * 客戶列表的儲存視圖：把一組搜尋、篩選與排序存起來，下次一鍵套用。
 *
 * 存進去的條件一律先過 normalizeCustomerQuery。視圖會活得比程式碼久——
 * 今天存的排序欄位，明天可能被改名或拿掉；讓一筆存壞的視圖把列表頁弄爛，
 * 比忽略那個條件糟糕得多。所以進出兩邊都收斂一次。
 *
 * 頁碼刻意不存。「回到我上次停在第 7 頁」不是使用者要的，而且資料一直在變，
 * 同一個頁碼下次指到的根本是別人。
 */

export type SavedViewRow = typeof crmSavedViews.$inferSelect;

/** 視圖存的就是列表的查詢條件，只是少了頁碼。 */
export type SavedViewQuery = Omit<CustomerQuery, "page">;

export function savedViewQuery(view: SavedViewRow): SavedViewQuery {
  const { page: _page, ...rest } = normalizeCustomerQuery(view);
  return rest;
}

export async function listSavedViews(db: Database): Promise<SavedViewRow[]> {
  // 照建立時間排，順序才穩定——名稱排序會讓人改個名字就整排跳動。
  return db.select().from(crmSavedViews).orderBy(asc(crmSavedViews.createdAt));
}

export async function createSavedView(
  db: Database,
  input: Partial<Record<keyof CustomerQuery, unknown>> & { name: string; createdByEmail: string },
): Promise<{ id: string } | "duplicate"> {
  const name = input.name.trim();
  const [existing] = await db
    .select({ id: crmSavedViews.id })
    .from(crmSavedViews)
    .where(eq(crmSavedViews.name, name))
    .limit(1);
  if (existing) return "duplicate";

  const { page: _page, ...query } = normalizeCustomerQuery(input);
  const id = crypto.randomUUID();
  await db.insert(crmSavedViews).values({ id, name, ...query, createdByEmail: input.createdByEmail });
  return { id };
}

export async function deleteSavedView(db: Database, id: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: crmSavedViews.id })
    .from(crmSavedViews)
    .where(eq(crmSavedViews.id, id))
    .limit(1);
  if (!existing) return false;

  await db.delete(crmSavedViews).where(eq(crmSavedViews.id, id));
  return true;
}
