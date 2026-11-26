import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import { cyberbizOrderRestocks } from "./schema/cyberbiz-order-restocks.js";

/** 待處理或結果不明的回補，不能被官網快照／盤點推送繞過。觀察模式不改變既有庫存流程。 */
export async function hasUnresolvedOrderRestock(db: Database, itemId: string, exceptId?: string): Promise<boolean> {
  const rows = await db.select({ id: cyberbizOrderRestocks.id }).from(cyberbizOrderRestocks).where(and(
    eq(cyberbizOrderRestocks.itemId, itemId),
    eq(cyberbizOrderRestocks.mode, "apply"),
    inArray(cyberbizOrderRestocks.state, ["pending", "checking", "applying", "review"]),
    ...(exceptId ? [ne(cyberbizOrderRestocks.id, exceptId)] : []),
  )).limit(1);
  return rows.length > 0;
}
