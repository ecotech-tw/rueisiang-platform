import { can } from "@rueisiang/auth";
import { loadWarehouse, type Database } from "@rueisiang/db";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";
import {
  itemCategories,
  itemComponents,
  items as itemMasters,
  cyberbizProductCatalog,
  wmsItems,
  wmsCategories,
  wmsShelves,
  wmsZones,
  reportItemSalesMonthly,
} from "@rueisiang/db/schema";

const COLORS = new Set(["rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand"]);

function normalizeColor(value: unknown): string {
  const color = String(value ?? "rose").trim();
  return COLORS.has(color) ? color : "rose";
}

async function findCategoryId(db: Database, raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const [byId] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.id, value)).limit(1);
  if (byId) return byId.id;
  const [byName] = await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, value)).limit(1);
  return byName?.id ?? null;
}

/** 品項列表。items 是商品身分，wms_items 只是其中需要入庫管理的延伸資料。 */
export const items = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/categories", requirePermission("items:category:read"), async (c) => {
    const rows = await c.get("db")
      .select({
        id: itemCategories.id,
        name: itemCategories.name,
        color: itemCategories.color,
        active: itemCategories.active,
        usageCount: count(itemMasters.id),
        parentId: itemCategories.parentId,
        depth: itemCategories.depth,
      })
      .from(itemCategories)
      .leftJoin(itemMasters, eq(itemMasters.categoryId, itemCategories.id))
      .groupBy(itemCategories.id)
      .orderBy(asc(itemCategories.sortOrder), asc(itemCategories.name));
    return c.json({ categories: rows });
  })
  .post("/categories", requirePermission("items:category:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "分類名稱").slice(0, 40);
    const parentId = typeof input.parentId === "string" && input.parentId.trim() ? input.parentId.trim() : null;
    let depth = 0;
    if (parentId) {
      const [parent] = await c.get("db").select({ id: itemCategories.id, depth: itemCategories.depth }).from(itemCategories).where(eq(itemCategories.id, parentId)).limit(1);
      if (!parent || parent.depth !== 0) throw new HTTPException(400, { message: "子分類的上層必須是大分類。" });
      depth = 1;
    }
    const [duplicate] = await c.get("db").select({ id: itemCategories.id }).from(itemCategories).where(and(eq(itemCategories.name, name), parentId ? eq(itemCategories.parentId, parentId) : eq(itemCategories.depth, 0))).limit(1);
    if (duplicate) throw new HTTPException(409, { message: `同一層級已有品項分類「${name}」。` });
    const category = { id: crypto.randomUUID(), depth, parentId, parentDepth: parentId ? 0 : null, name, color: normalizeColor(input.color) };
    await c.get("db").insert(itemCategories).values(category);
    return c.json(category, 201);
  })
  .post("/categories/reorder", requirePermission("items:category:write"), async (c) => {
    const input = await body(c);
    const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
    const parents = (input.parents && typeof input.parents === "object" ? input.parents : {}) as Record<string, unknown>;
    if (!ids.length || new Set(ids).size !== ids.length) throw new HTTPException(400, { message: "分類排序資料不正確。" });
    const rows = await c.get("db").select({ id: itemCategories.id }).from(itemCategories);
    if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.id))) throw new HTTPException(400, { message: "分類排序資料與目前分類不一致，請重新整理後再試。" });
    const parentIds = ids.map((id) => typeof parents[id] === "string" && parents[id] ? parents[id] as string : null);
    const rootIds = new Set(ids.filter((_id, index) => parentIds[index] === null));
    if (parentIds.some((parentId, index) => parentId !== null && (parentId === ids[index] || !rootIds.has(parentId)))) throw new HTTPException(400, { message: "分類階層不正確；子分類只能放在大分類底下。" });
    await c.get("db").batch(ids.map((id, sortOrder) => c.get("db").update(itemCategories).set({ sortOrder, parentId: parentIds[sortOrder], parentDepth: parentIds[sortOrder] ? 0 : null, depth: parentIds[sortOrder] ? 1 : 0, updatedAt: new Date().toISOString() }).where(eq(itemCategories.id, id))) as never);
    return c.json({ ok: true });
  })
  .patch("/categories/:id", requirePermission("items:category:write"), async (c) => {
    const input = await body(c);
    const id = c.req.param("id");
    const [current] = await c.get("db").select().from(itemCategories).where(eq(itemCategories.id, id)).limit(1);
    if (!current) throw new HTTPException(404, { message: "找不到品項分類。" });
    let parentId = current.parentId;
    let depth = current.depth;
    if (input.parentId !== undefined) {
      parentId = typeof input.parentId === "string" && input.parentId.trim() ? input.parentId.trim() : null;
      if (parentId) {
        const [parent] = await c.get("db").select({ id: itemCategories.id, depth: itemCategories.depth }).from(itemCategories).where(eq(itemCategories.id, parentId)).limit(1);
        if (!parent || parent.depth !== 0 || parent.id === id) throw new HTTPException(400, { message: "子分類的上層必須是其他大分類。" });
      }
      depth = parentId ? 1 : 0;
    }
    const patch = {
      ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim().slice(0, 40) } : {}),
      ...(input.color !== undefined ? { color: normalizeColor(input.color) } : {}),
      parentId,
      parentDepth: parentId ? 0 : null,
      depth,
      updatedAt: new Date().toISOString(),
    };
    await c.get("db").update(itemCategories).set(patch).where(eq(itemCategories.id, id));
    return c.json({ id, ...patch });
  })
  .delete("/categories/:id", requirePermission("items:category:write"), async (c) => {
    const id = c.req.param("id");
    const [{ total } = { total: 0 }] = await c.get("db").select({ total: count() }).from(itemMasters).where(eq(itemMasters.categoryId, id));
    if (Number(total) > 0) throw new HTTPException(409, { message: `還有 ${total} 個品項使用這個分類。` });
    await c.get("db").delete(itemCategories).where(eq(itemCategories.id, id));
    return c.json({ ok: true });
  })
  .get("/catalog", requirePermission("items:item:read"), async (c) => {
    const db = c.get("db");
    const [warehouse, categories, masterRows, cyberbizRows, targetWmsRows] = await Promise.all([
      loadWarehouse(db),
      db.select({ id: itemCategories.id, name: itemCategories.name, color: itemCategories.color, parentId: itemCategories.parentId, depth: itemCategories.depth }).from(itemCategories).orderBy(asc(itemCategories.depth), asc(itemCategories.sortOrder), asc(itemCategories.name)),
      db.select({
        id: itemMasters.id,
        source: itemMasters.source,
        sku: itemMasters.sku,
        name: itemMasters.name,
        kind: itemMasters.kind,
        categoryId: itemMasters.categoryId,
        active: itemMasters.active,
      }).from(itemMasters).orderBy(asc(itemMasters.name)),
      db.select({
        sku: itemMasters.sku,
        productId: cyberbizProductCatalog.cyberbizProductId,
        variantId: cyberbizProductCatalog.cyberbizVariantId,
        productName: cyberbizProductCatalog.productName,
        variantName: cyberbizProductCatalog.variantName,
        published: cyberbizProductCatalog.published,
        reportCategoryName: itemCategories.name,
      })
        .from(cyberbizProductCatalog)
        .innerJoin(itemMasters, eq(itemMasters.id, cyberbizProductCatalog.itemId))
        .leftJoin(itemCategories, eq(itemCategories.id, itemMasters.categoryId))
        .orderBy(asc(cyberbizProductCatalog.productName), asc(cyberbizProductCatalog.variantName), asc(itemMasters.sku)),
      db.select().from(wmsItems),
    ]);

    const itemCategoryById = new Map(categories.map((category) => [category.id, category]));
    const wmsByItemId = new Map(targetWmsRows.map((row) => [row.itemId, row]));
    const catalogItems = masterRows.map((row) => {
      const wms = wmsByItemId.get(row.id);
      return {
        id: row.id,
        sku: row.sku,
        name: row.name || row.sku,
        source: row.source,
        kind: row.kind,
        active: row.active,
        category: itemCategoryById.get(row.categoryId ?? "")?.name ?? "未分類",
        categoryId: row.categoryId,
        categoryColor: itemCategoryById.get(row.categoryId ?? "")?.color ?? "slate",
        inWarehouse: Boolean(wms),
        quantity: wms?.quantity ?? null,
        unit: wms?.unit ?? "",
        minStock: wms?.minStock ?? null,
        notes: wms?.notes ?? "",
        cyberbiz: row.source === "cyberbiz",
      };
    });

    return c.json({
      items: catalogItems,
      categories,
      warehouseCategories: can(c.get("user"), "wms:inventory:write") ? warehouse.categories : [],
      cyberbizProducts: cyberbizRows,
      zones: can(c.get("user"), "wms:map:read") ? warehouse.zones : [],
    });
  })
  .post("/catalog", requirePermission("items:item:write"), async (c) => {
    const input = await body(c);
    const db = c.get("db");
    const categoryId = await findCategoryId(db, input.categoryId ?? input.category);
    const now = new Date().toISOString();

    // SKU 留白＝包材或半成品（淋膜紙、護髮素軟管這些本來就沒有 SKU）。自動編一組
    // WMS- 開頭的號碼，並把 kind 設成 supply；有填 SKU 的就是拿去賣的東西。
    // 編號規則與 0076 回填既有那六筆時用的一樣。
    const id = crypto.randomUUID();
    const inputSku = typeof input.sku === "string" ? input.sku.trim().toUpperCase() : "";
    const sku = inputSku || `WMS-${id.slice(0, 8).toUpperCase()}`;
    // SKU 是全平台唯一（items 的 idx_items_sku），所以這裡不能只查 custom：
    // 打到既有的 CYBERBIZ SKU 一樣是重複，只是會撞在索引上變成看不懂的訊息。
    const [duplicate] = await db.select({ name: itemMasters.name, source: itemMasters.source })
      .from(itemMasters).where(eq(itemMasters.sku, sku)).limit(1);
    if (duplicate) {
      throw new HTTPException(409, duplicate.source === "cyberbiz"
        ? { message: `SKU「${sku}」已經是 CYBERBIZ 品項「${duplicate.name}」，直接用那一筆就好。` }
        : { message: `SKU「${sku}」已被自訂品項「${duplicate.name}」使用。` });
    }
    const item = {
      id,
      source: "custom" as const,
      kind: inputSku ? "sellable" as const : "supply" as const,
      sku,
      name: requireString(input, "name", "商品名稱"),
      categoryId,
      active: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(itemMasters).values(item);
    return c.json({ id: item.id, sku: item.sku }, 201);
  })
  .patch("/catalog/:id", requirePermission("items:item:write"), async (c) => {
    const input = await body(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const [current] = await db.select().from(itemMasters).where(eq(itemMasters.id, id)).limit(1);
    if (!current) throw new HTTPException(404, { message: "找不到品項。" });

    const categoryId = input.categoryId === undefined && input.category === undefined
      ? current.categoryId
      : await findCategoryId(db, input.categoryId ?? input.category);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : current.name;
    const active = input.active === undefined ? current.active : Number(input.active) ? 1 : 0;
    // kind 是我們的判斷，不是同步來的事實：0076 只憑「有沒有 SKU」分了一輪，
    // 分錯的要有地方改，不然這一欄永遠不能拿來當過濾條件。
    const kind = input.kind === "supply" || input.kind === "sellable" ? input.kind : current.kind;
    let sku = current.sku;
    if (input.sku !== undefined) {
      const requestedSku = requireString(input, "sku", "SKU").toUpperCase();
      if (current.source !== "custom" && requestedSku !== current.sku) {
        throw new HTTPException(409, { message: "這項品項已連結 CYBERBIZ，SKU 必須與官網連結一致，不能在 WMS 修改。" });
      }
      if (requestedSku !== current.sku) {
        const [duplicate] = await db.select({ id: itemMasters.id, name: itemMasters.name })
          .from(itemMasters)
          .where(and(eq(itemMasters.sku, requestedSku), ne(itemMasters.id, id)))
          .limit(1);
        if (duplicate) throw new HTTPException(409, { message: `SKU「${requestedSku}」已被品項「${duplicate.name}」使用。` });
        sku = requestedSku;
      }
    }
    await db.update(itemMasters).set({ name, sku, kind, categoryId, active, updatedAt: new Date().toISOString() }).where(eq(itemMasters.id, id));
    return c.json({ id, sku, name, kind, categoryId, active });
  })
  .delete("/catalog/:id", requirePermission("items:item:write"), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [item] = await db.select().from(itemMasters).where(eq(itemMasters.id, id)).limit(1);
    if (!item) throw new HTTPException(404, { message: "找不到品項。" });
    if (item.source === "cyberbiz") throw new HTTPException(409, { message: "CYBERBIZ 品項由同步管理，請停用品項，不要刪除主檔。" });
    const [wms] = await db.select({ itemId: wmsItems.itemId }).from(wmsItems).where(eq(wmsItems.itemId, id)).limit(1);
    if (wms) throw new HTTPException(409, { message: "品項仍在倉儲中，請先移出倉儲。" });
    const [component] = await db.select({ parentItemId: itemComponents.parentItemId }).from(itemComponents).where(eq(itemComponents.componentItemId, id)).limit(1);
    if (component) throw new HTTPException(409, { message: "品項仍是 BOM 用料，請先移除組成。" });
    const [sales] = await db.select({ scopeId: reportItemSalesMonthly.scopeId }).from(reportItemSalesMonthly).where(eq(reportItemSalesMonthly.itemId, id)).limit(1);
    if (sales) throw new HTTPException(409, { message: "品項已有報表紀錄，請停用品項，不要刪除主檔。" });
    await db.delete(itemMasters).where(eq(itemMasters.id, id));
    return c.json({ ok: true });
  })
  .post("/catalog/:id/warehouse", requirePermission("wms:inventory:write"), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const input = await body(c);
    const [item] = await db.select({ id: itemMasters.id }).from(itemMasters).where(eq(itemMasters.id, id)).limit(1);
    if (!item) throw new HTTPException(404, { message: "找不到品項。" });
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
