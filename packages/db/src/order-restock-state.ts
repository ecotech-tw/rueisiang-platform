import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { cyberbizOrderRestocks } from "./schema/cyberbiz-order-restocks.js";

function unresolvedCondition(itemId: string, exceptId?: string) {
  return and(
    eq(cyberbizOrderRestocks.itemId, itemId),
    eq(cyberbizOrderRestocks.mode, "apply"),
    inArray(cyberbizOrderRestocks.state, ["pending", "checking", "applying", "review"]),
    ...(exceptId ? [ne(cyberbizOrderRestocks.id, exceptId)] : []),
  );
}

/** 同步與盤點的寫入條件共用同一規則，不能只靠較早的 SELECT 防止入站競態。 */
export function noUnresolvedOrderRestock(itemId: string) {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM ${cyberbizOrderRestocks} WHERE ${unresolvedCondition(itemId)})`;
}

/** 待處理或結果不明的回補，不能被官網快照／盤點推送繞過。觀察模式不改變既有庫存流程。 */
export async function hasUnresolvedOrderRestock(db: Database, itemId: string, exceptId?: string): Promise<boolean> {
  const rows = await db.select({ id: cyberbizOrderRestocks.id }).from(cyberbizOrderRestocks).where(unresolvedCondition(itemId, exceptId)).limit(1);
  return rows.length > 0;
}
