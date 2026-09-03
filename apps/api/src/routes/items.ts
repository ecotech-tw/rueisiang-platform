import { can } from "@rueisiang/auth";
import { loadWarehouse, type Database } from "@rueisiang/db";
import { and, asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";
import {
  cyberbizProducts,
  itemCategories,
  items as itemMasters,
  reportProductCategories,
  cyberbizProductCategories,
  wmsItems,
  wmsCategories,
  wmsShelves,
  wmsZones,
} from "@rueisiang/db/schema";

const COLORS = new Set(["rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand"]);

function normalizeColor(value: unknown): string {
  const color = String(value ?? "rose").trim();
  return COLORS.has(color) ? color : "rose";
}

function displayCyberbizName(row: { productName: string; variantName: string }): string {
  return `${row.productName}${row.variantName ? `（${row.variantName}）` : ""}`;
}

async function findCategoryId(db: Database, raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const [byId] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.id, value)).limit(1);
  if (byId) return byId.id;
  const [byName] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, value)).limit(1);
  return byName?.id ?? null;
}

/**
 * 過渡期保護 invariant：CYBERBIZ 目錄鏡像進來後，一定要有對應的 items。
 * 正式版會放在 CYBERBIZ sync service；目前先在 item catalog 讀取前補齊，避免 UI
 * 看到「官網有、平台主檔沒有」卻無法被報表 / WMS 參照。
 */
async function ensureCyberbizItemMasters(db: Database): Promise<void> {
  const [catalog, existing] = await Promise.all([
    db.select({
      sku: cyberbizProducts.sku,
      productName: cyberbizProducts.productName,
      variantName: cyberbizProducts.variantName,
    }).from(cyberbizProducts),
    db.select({ sku: itemMasters.sku }).from(itemMasters).where(eq(itemMasters.source, "cyberbiz")),
  ]);
  const existingSkus = new Set(existing.map((row) => row.sku));
  const now = new Date().toISOString();
  const missing = catalog.filter((row) => !existingSkus.has(row.sku));
  for (const row of missing) {
    await db.insert(itemMasters).values({
      id: crypto.randomUUID(),
      source: "cyberbiz",
      kind: "sellable",
      sku: row.sku,
      name: displayCyberbizName(row),
      categoryId: null,
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 品項主檔。items 是商品身分，wms_items 只是其中需要入庫管理的延伸資料。 */
export const items = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/categories", requirePermission("wms:inventory:read"), async (c) => {
    const rows = await c.get("db")
      .select({
        id: itemCategories.id,
        name: itemCategories.name,
        color: itemCategories.color,
        active: itemCategories.active,
        usageCount: count(itemMasters.id),
      })
      .from(itemCategories)
      .leftJoin(itemMasters, eq(itemMasters.categoryId, itemCategories.id))
      .where(eq(itemCategories.depth, 0))
      .groupBy(itemCategories.id)
      .orderBy(asc(itemCategories.sortOrder), asc(itemCategories.name));
    return c.json({ categories: rows });
  })
  .post("/categories", requirePermission("wms:category:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "分類名稱").slice(0, 40);
    const [duplicate] = await c.get("db").select({ id: itemCategories.id }).from(itemCategories).where(and(eq(itemCategories.name, name), eq(itemCategories.depth, 0))).limit(1);
    if (duplicate) throw new HTTPException(409, { message: `品項分類「${name}」已經存在。` });
    const category = { id: crypto.randomUUID(), depth: 0, name, color: normalizeColor(input.color) };
    await c.get("db").insert(itemCategories).values(category);
    return c.json(category, 201);
  })
  .patch("/categories/:id", requirePermission("wms:category:write"), async (c) => {
    const input = await body(c);
    const id = c.req.param("id");
    const [current] = await c.get("db").select().from(itemCategories).where(eq(itemCategories.id, id)).limit(1);
    if (!current) throw new HTTPException(404, { message: "找不到品項分類。" });
    const patch = {
      ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim().slice(0, 40) } : {}),
      ...(input.color !== undefined ? { color: normalizeColor(input.color) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await c.get("db").update(itemCategories).set(patch).where(eq(itemCategories.id, id));
    return c.json({ id, ...patch });
  })
  .delete("/categories/:id", requirePermission("wms:category:write"), async (c) => {
    const id = c.req.param("id");
    const [{ total } = { total: 0 }] = await c.get("db").select({ total: count() }).from(itemMasters).where(eq(itemMasters.categoryId, id));
    if (Number(total) > 0) throw new HTTPException(409, { message: `還有 ${total} 個品項使用這個分類。` });
    await c.get("db").delete(itemCategories).where(eq(itemCategories.id, id));
    return c.json({ ok: true });
  })
  .get("/catalog", requirePermission("wms:inventory:read"), async (c) => {
    const db = c.get("db");
    await ensureCyberbizItemMasters(db);
    const [warehouse, categories, masterRows, cyberbizRows, targetWmsRows] = await Promise.all([
      loadWarehouse(db),
      db.select({ id: itemCategories.id, name: itemCategories.name, color: itemCategories.color }).from(itemCategories).where(eq(itemCategories.depth, 0)).orderBy(asc(itemCategories.sortOrder), asc(itemCategories.name)),
      db.select({
        id: itemMasters.id,
        source: itemMasters.source,
        sku: itemMasters.sku,
        name: itemMasters.name,
        categoryId: itemMasters.categoryId,
        categoryName: itemCategories.name,
        categoryColor: itemCategories.color,
        active: itemMasters.active,
      }).from(itemMasters).leftJoin(itemCategories, eq(itemCategories.id, itemMasters.categoryId)).orderBy(asc(itemMasters.name)),
      db.select({
        sku: cyberbizProducts.sku,
        productId: cyberbizProducts.productId,
        variantId: cyberbizProducts.variantId,
        productName: cyberbizProducts.productName,
        variantName: cyberbizProducts.variantName,
        published: cyberbizProducts.published,
        reportCategoryName: reportProductCategories.name,
      })
        .from(cyberbizProducts)
        .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
        .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
        .orderBy(asc(cyberbizProducts.productName), asc(cyberbizProducts.variantName), asc(cyberbizProducts.sku)),
      db.select().from(wmsItems),
    ]);

    const masterSkus = new Set(masterRows.map((row) => `${row.source}:${row.sku}`));
    const wmsBySku = new Map(warehouse.items.filter((item) => item.sku).map((item) => [item.sku!, item]));
    const wmsByItemId = new Map(targetWmsRows.map((row) => [row.itemId, row]));
    const catalogItems = [
      ...masterRows.map((row) => {
        const legacyWms = wmsBySku.get(row.sku);
        const targetWms = wmsByItemId.get(row.id);
        return {
          id: row.id,
          sku: row.sku,
          name: row.name,
          source: row.source,
          category: row.categoryName ?? "未分類",
          categoryId: row.categoryId,
          categoryColor: row.categoryColor ?? "slate",
          inWarehouse: Boolean(targetWms || legacyWms),
          quantity: targetWms?.quantity ?? legacyWms?.quantity ?? null,
          unit: targetWms?.unit ?? legacyWms?.unit ?? "",
          minStock: targetWms?.minStock ?? legacyWms?.minStock ?? null,
          notes: targetWms?.notes ?? legacyWms?.notes ?? "",
          cyberbiz: row.source === "cyberbiz",
        };
      }),
      ...cyberbizRows
        .filter((row) => !masterSkus.has(`cyberbiz:${row.sku}`))
        .map((row) => ({
          id: `cyberbiz:${row.sku}`,
          sku: row.sku,
          name: displayCyberbizName(row),
          source: "cyberbiz" as const,
          category: row.reportCategoryName ?? "未分類",
          categoryId: null,
          categoryColor: "slate",
          inWarehouse: Boolean(wmsBySku.get(row.sku)),
          quantity: wmsBySku.get(row.sku)?.quantity ?? null,
          unit: wmsBySku.get(row.sku)?.unit ?? "",
          minStock: wmsBySku.get(row.sku)?.minStock ?? null,
          notes: "CYBERBIZ 已同步，但尚未建立 item 主檔",
          cyberbiz: true,
        })),
      ...warehouse.items
        .filter((item) => item.sku && !masterSkus.has(`custom:${item.sku}`) && !masterSkus.has(`cyberbiz:${item.sku}`))
        .map((item) => ({
          id: `wms:${item.id}`,
          sku: item.sku!,
          name: item.name,
          source: "wms" as const,
          category: item.category,
          categoryId: null,
          categoryColor: "slate",
          inWarehouse: true,
          quantity: item.quantity,
          unit: item.unit,
          minStock: item.minStock,
          notes: "既有 WMS 品項，尚未搬入 item 主檔",
          cyberbiz: Boolean(item.cyberbiz),
        })),
    ];

    return c.json({
      items: catalogItems,
      categories,
      warehouseCategories: warehouse.categories,
      cyberbizProducts: cyberbizRows,
      zones: can(c.get("user"), "wms:map:read") ? warehouse.zones : [],
    });
  })
  .post("/catalog", requirePermission("wms:inventory:write"), async (c) => {
    const input = await body(c);
    const db = c.get("db");
    const selectedSku = typeof input.cyberbizSku === "string" ? input.cyberbizSku.trim().toUpperCase() : "";
    const categoryId = await findCategoryId(db, input.categoryId ?? input.category);
    const now = new Date().toISOString();

    if (selectedSku) {
      const [selected] = await db.select().from(cyberbizProducts).where(eq(cyberbizProducts.sku, selectedSku)).limit(1);
      if (!selected) throw new HTTPException(404, { message: `找不到 CYBERBIZ SKU「${selectedSku}」。` });
      const [duplicate] = await db.select({ id: itemMasters.id }).from(itemMasters).where(and(eq(itemMasters.source, "cyberbiz"), eq(itemMasters.sku, selected.sku))).limit(1);
      if (duplicate) throw new HTTPException(409, { message: `CYBERBIZ SKU「${selected.sku}」已經有品項主檔。` });
      const item = {
        id: crypto.randomUUID(),
        source: "cyberbiz" as const,
        kind: "sellable" as const,
        sku: selected.sku,
        name: displayCyberbizName(selected),
        categoryId,
        active: 1,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(itemMasters).values(item);
      return c.json({ id: item.id, cyberbizSku: selected.sku }, 201);
    }

    const sku = requireString(input, "sku", "SKU").toUpperCase();
    const [duplicate] = await db.select({ id: itemMasters.id }).from(itemMasters).where(and(eq(itemMasters.source, "custom"), eq(itemMasters.sku, sku))).limit(1);
    if (duplicate) throw new HTTPException(409, { message: `自建 SKU「${sku}」已經有品項主檔。` });
    const item = {
      id: crypto.randomUUID(),
      source: "custom" as const,
      kind: "supply" as const,
      sku,
      name: requireString(input, "name", "商品名稱"),
      categoryId,
      active: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(itemMasters).values(item);
    return c.json({ id: item.id, cyberbizSku: null }, 201);
  })
  .patch("/catalog/:id", requirePermission("wms:inventory:write"), async (c) => {
    const input = await body(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const [current] = await db.select().from(itemMasters).where(eq(itemMasters.id, id)).limit(1);
    if (!current) throw new HTTPException(404, { message: "找不到品項主檔。" });

    const categoryId = input.categoryId === undefined && input.category === undefined
      ? current.categoryId
      : await findCategoryId(db, input.categoryId ?? input.category);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : current.name;
    const active = input.active === undefined ? current.active : Number(input.active) ? 1 : 0;
    await db.update(itemMasters).set({ name, categoryId, active, updatedAt: new Date().toISOString() }).where(eq(itemMasters.id, id));
    return c.json({ id, name, categoryId, active });
  })
  .post("/catalog/:id/warehouse", requirePermission("wms:inventory:write"), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const input = await body(c);
    const [item] = await db.select({ id: itemMasters.id }).from(itemMasters).where(eq(itemMasters.id, id)).limit(1);
    if (!item) throw new HTTPException(404, { message: "找不到品項主檔。" });
    const [existing] = await db.select({ itemId: wmsItems.itemId }).from(wmsItems).where(eq(wmsItems.itemId, id)).limit(1);
    if (existing) throw new HTTPException(409, { message: "這個品項已經納入倉儲。" });

    const wmsCategoryId = typeof input.wmsCategoryId === "string" && input.wmsCategoryId.trim() ? input.wmsCategoryId.trim() : null;
    if (wmsCategoryId) {
      const [category] = await db.select({ id: wmsCategories.id }).from(wmsCategories).where(eq(wmsCategories.id, wmsCategoryId)).limit(1);
      if (!category) throw new HTTPException(404, { message: "找不到指定的倉儲分類。" });
    }
    let shelfId: string | null = null;
    const zoneId = typeof input.zoneId === "string" && input.zoneId.trim() ? input.zoneId.trim() : null;
    const shelfCode = typeof input.shelfLevel === "string" && input.shelfLevel.trim() ? input.shelfLevel.trim() : null;
    if (zoneId && shelfCode) {
      const [zone] = await db.select({ id: wmsZones.id }).from(wmsZones).where(eq(wmsZones.id, zoneId)).limit(1);
      if (!zone) throw new HTTPException(404, { message: "找不到指定的倉位。" });
      const [shelf] = await db.select({ id: wmsShelves.id }).from(wmsShelves).where(and(eq(wmsShelves.zoneId, zoneId), eq(wmsShelves.code, shelfCode))).limit(1);
      shelfId = shelf?.id ?? crypto.randomUUID();
      if (!shelf) {
        await db.insert(wmsShelves).values({
          id: shelfId,
          zoneId,
          code: shelfCode,
          name: typeof input.shelfName === "string" && input.shelfName.trim() ? input.shelfName.trim() : shelfCode,
          sortOrder: 0,
          active: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    await db.insert(wmsItems).values({
      itemId: id,
      wmsCategoryId,
      shelfId,
      quantity: Math.max(0, Math.round(Number(input.quantity ?? 0) || 0)),
      unit: typeof input.unit === "string" && input.unit.trim() ? input.unit.trim() : "件",
      minStock: Math.max(0, Math.round(Number(input.minStock ?? 5) || 0)),
      notes: typeof input.notes === "string" ? input.notes.trim() : "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });
