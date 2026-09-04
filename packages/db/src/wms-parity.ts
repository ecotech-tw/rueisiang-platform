import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { items as itemMasters } from "./schema/items.js";
import { inventoryItems, wmsItems } from "./schema/wms.js";

export interface WmsParityReport {
  legacyCount: number;
  targetCount: number;
  missingTargetIds: string[];
  quantityMismatches: Array<{ id: string; legacy: number; target: number }>;
}

/** 供正式搬移前驗證兩套 WMS 資料；只回報差異，不會修改資料。 */
export async function checkWmsParity(db: Database): Promise<WmsParityReport> {
  const [legacy, target] = await Promise.all([
    db.select({ id: inventoryItems.id, quantity: inventoryItems.quantity }).from(inventoryItems),
    db.select({ id: itemMasters.id, quantity: wmsItems.quantity }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)),
  ]);
  const targetById = new Map(target.map((row) => [row.id, row]));
  const missingTargetIds: string[] = [];
  const quantityMismatches: WmsParityReport["quantityMismatches"] = [];
  for (const row of legacy) {
    const match = targetById.get(row.id);
    if (!match) missingTargetIds.push(row.id);
    else if (match.quantity !== row.quantity) quantityMismatches.push({ id: row.id, legacy: row.quantity, target: match.quantity });
  }
  return { legacyCount: legacy.length, targetCount: target.length, missingTargetIds, quantityMismatches };
}
