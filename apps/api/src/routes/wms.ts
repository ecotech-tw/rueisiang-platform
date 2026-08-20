import { can } from "@rueisiang/auth";
import {
  countItem,
  createCategory,
  createItem,
  createLayoutElement,
  createZone,
  deleteCategory,
  deleteItem,
  deleteLayoutElement,
  deleteZone,
  loadWarehouse,
  updateCategory,
  updateItem,
  updateLayoutElement,
  updateWarehouseSettings,
  updateZone,
} from "@rueisiang/db";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

/**
 * 倉儲管理。
 *
 * 業務邏輯全在 packages/db 的 wms.ts，這裡只做三件事：讀參數、掛權限、把結果
 * 變成 JSON。判斷「這個層架還有沒有東西」「這個分類還有沒有人用」那些不要
 * 搬到這裡來——那會變成第二份業務邏輯。
 */

/** 只取字串欄位；沒帶就是 undefined（代表「這次不動它」），不是空字串。 */
function text(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * 位置欄位。zoneId 明確送 null 代表「從倉位拿出來」，沒送代表「不動」——
 * 兩者不能合併成同一個值，不然沒辦法把東西移出倉位。
 */
function placement(input: Record<string, unknown>) {
  return {
    ...("zoneId" in input ? { zoneId: text(input, "zoneId") ?? null } : {}),
    ...("shelfLevel" in input ? { shelfLevel: text(input, "shelfLevel") ?? null } : {}),
  };
}

export const wms = new Hono<AppEnv>()
  .use("*", requireAuth)

  /**
   * 地圖那一頁的全部資料，一次給完。
   *
   * 掛 wms:map:read，但庫存明細另外看 wms:inventory:read：地圖本身跟「每一格
   * 裡面有什麼」是兩種權限，自訂角色可能只給前者。少了後者就回空陣列而不是
   * 403——地圖還是看得到的，只是格子裡是空的。
   */
  .get("/warehouse", requirePermission("wms:map:read"), async (c) => {
    const warehouse = await loadWarehouse(c.get("db"));
    if (can(c.get("user"), "wms:inventory:read")) return c.json(warehouse);
    return c.json({ ...warehouse, items: [], categories: [] });
  })

  // ───────────────────────────── 倉位 ─────────────────────────────

  .post("/zones", requirePermission("wms:map:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await createZone(c.get("db"), {
      code: requireString(input, "code", "倉位代碼"),
      name: requireString(input, "name", "倉位名稱"),
      category: text(input, "category"),
      color: text(input, "color"),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      shelfLevels: input.shelfLevels,
      notes: text(input, "notes"),
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .patch("/zones/:id", requirePermission("wms:map:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    await updateZone(c.get("db"), c.req.param("id"), {
      code: text(input, "code"),
      name: text(input, "name"),
      category: text(input, "category"),
      color: text(input, "color"),
      // 拖曳只會送 x/y，所以這些一律原樣傳下去，由 wms.ts 判斷有沒有帶。
      ...("x" in input ? { x: input.x } : {}),
      ...("y" in input ? { y: input.y } : {}),
      ...("width" in input ? { width: input.width } : {}),
      ...("height" in input ? { height: input.height } : {}),
      ...("shelfLevels" in input ? { shelfLevels: input.shelfLevels } : {}),
      notes: text(input, "notes"),
      actor: { id: user.id, email: user.email },
    });
    return c.json({ ok: true });
  })

  .delete("/zones/:id", requirePermission("wms:map:write"), async (c) => {
    const user = c.get("user");
    await deleteZone(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  // ───────────────────────────── 庫存品項 ─────────────────────────────

  .post("/items", requirePermission("wms:inventory:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await createItem(c.get("db"), {
      sku: text(input, "sku"),
      name: requireString(input, "name", "商品名稱"),
      category: requireString(input, "category", "商品分類"),
      quantity: input.quantity,
      unit: text(input, "unit"),
      minStock: input.minStock,
      zoneId: text(input, "zoneId") ?? null,
      shelfLevel: text(input, "shelfLevel") ?? null,
      notes: text(input, "notes"),
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .patch("/items/:id", requirePermission("wms:inventory:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    await updateItem(c.get("db"), c.req.param("id"), {
      ...("sku" in input ? { sku: text(input, "sku") ?? "" } : {}),
      name: text(input, "name"),
      category: text(input, "category"),
      unit: text(input, "unit"),
      ...("minStock" in input ? { minStock: input.minStock } : {}),
      ...placement(input),
      notes: text(input, "notes"),
      actor: { id: user.id, email: user.email },
    });
    return c.json({ ok: true });
  })

  .delete("/items/:id", requirePermission("wms:inventory:write"), async (c) => {
    const user = c.get("user");
    await deleteItem(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  /**
   * 盤點。獨立一條路由、獨立一個權限。
   *
   * 倉庫的人要能數數量，但不該能改 SKU、改分類、把東西搬到別的倉位——那些是
   * wms:inventory:write。合在 PATCH /items/:id 裡的話這個界線就沒了。
   */
  .patch("/items/:id/count", requirePermission("wms:inventory:count"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await countItem(
      c.get("db"),
      c.req.param("id"),
      input.quantity,
      { id: user.id, email: user.email },
      text(input, "note"),
    );
    return c.json(result);
  })

  // ───────────────────────────── 商品分類 ─────────────────────────────

  .post("/categories", requirePermission("wms:category:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await createCategory(c.get("db"), {
      name: requireString(input, "name", "分類名稱"),
      color: input.color,
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .patch("/categories/:id", requirePermission("wms:category:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    await updateCategory(c.get("db"), c.req.param("id"), {
      name: text(input, "name"),
      color: input.color,
      actor: { id: user.id, email: user.email },
    });
    return c.json({ ok: true });
  })

  .delete("/categories/:id", requirePermission("wms:category:write"), async (c) => {
    const user = c.get("user");
    await deleteCategory(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  // ───────────────────────── 地圖標示與畫布 ─────────────────────────

  .post("/elements", requirePermission("wms:map:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const result = await createLayoutElement(c.get("db"), {
      label: requireString(input, "label", "標示文字"),
      color: text(input, "color"),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  .patch("/elements/:id", requirePermission("wms:map:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    await updateLayoutElement(c.get("db"), c.req.param("id"), {
      label: text(input, "label"),
      color: text(input, "color"),
      ...("x" in input ? { x: input.x } : {}),
      ...("y" in input ? { y: input.y } : {}),
      ...("width" in input ? { width: input.width } : {}),
      ...("height" in input ? { height: input.height } : {}),
      actor: { id: user.id, email: user.email },
    });
    return c.json({ ok: true });
  })

  .delete("/elements/:id", requirePermission("wms:map:write"), async (c) => {
    const user = c.get("user");
    await deleteLayoutElement(c.get("db"), c.req.param("id"), { id: user.id, email: user.email });
    return c.json({ ok: true });
  })

  .patch("/settings", requirePermission("wms:map:write"), async (c) => {
    const input = await body(c);
    const user = c.get("user");
    const settings = await updateWarehouseSettings(c.get("db"), {
      canvasWidth: input.canvasWidth,
      canvasHeight: input.canvasHeight,
      actor: { id: user.id, email: user.email },
    });
    return c.json(settings);
  });
