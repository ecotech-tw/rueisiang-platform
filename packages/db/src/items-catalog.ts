import { asc, desc, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { itemCategories, items, wmsItems } from "./schema/index.js";

export interface ListItemsQuery {
  search?: string;
  source?: "all" | "cyberbiz" | "custom";
  kind?: "all" | "sellable" | "supply";
  active?: "true" | "false" | "all";
  limit?: number;
}

export interface ListItemsRow {
  itemId: string;
  sku: string;
  name: string;
  category: string;
  source: "cyberbiz" | "custom";
  kind: "sellable" | "supply";
  active: boolean;
  inWarehouse: boolean;
  quantity: number | null;
  unit: string | null;
  minStock: number | null;
}

export async function listItems(db: Database, query: ListItemsQuery = {}): Promise<ListItemsRow[]> {
  const search = query.search?.trim() ?? "";
  const terms = search.split(/[\s,，]+/u).map((term) => term.trim()).filter(Boolean);
  const limit = Math.min(50, Math.max(1, Math.floor(query.limit ?? 20)));
  const conditions = [
    ...(query.source === "cyberbiz" || query.source === "custom" ? [sql`${items.source} = ${query.source}`] : []),
    ...(query.kind === "sellable" || query.kind === "supply" ? [sql`${items.kind} = ${query.kind}`] : []),
    ...(query.active === "all" ? [] : [sql`${items.active} = ${query.active === "false" ? 0 : 1}`]),
    ...terms.map((term) => sql`(
      lower(${items.sku}) LIKE lower(${`%${term}%`})
      OR lower(${items.name}) LIKE lower(${`%${term}%`})
      OR lower(${itemCategories.name}) LIKE lower(${`%${term}%`})
    )`),
  ];

  const rows = await db.select({
    itemId: items.id,
    source: items.source,
    kind: items.kind,
    sku: items.sku,
    name: items.name,
    active: items.active,
    category: itemCategories.name,
    wmsItemId: wmsItems.itemId,
    quantity: wmsItems.quantity,
    unit: wmsItems.unit,
    minStock: wmsItems.minStock,
  })
    .from(items)
    .leftJoin(itemCategories, sql`${itemCategories.id} = ${items.categoryId}`)
    .leftJoin(wmsItems, sql`${wmsItems.itemId} = ${items.id}`)
    .where(conditions.length ? sql.join(conditions, sql` AND `) : undefined)
    .orderBy(desc(items.active), asc(items.name), asc(items.sku))
    .limit(limit);

  return rows.map((row) => ({
    itemId: row.itemId,
    sku: row.sku,
    name: row.name || row.sku,
    category: row.category ?? "未分類",
    source: row.source,
    kind: row.kind,
    active: row.active === 1,
    inWarehouse: Boolean(row.wmsItemId),
    quantity: row.wmsItemId ? row.quantity : null,
    unit: row.wmsItemId ? row.unit : null,
    minStock: row.wmsItemId ? row.minStock : null,
  }));
}
