import { can } from "@rueisiang/auth";
import {
  countItem,
  deleteZoneImage,
  findZoneImage,
  listZoneImages,
  recordZoneImage,
  zoneImageKeys,
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
import { HTTPException } from "hono/http-exception";
import { body, requireString } from "../request.js";

/** formData 送上來的檔案。只列出真的會用到的那幾個屬性，見上傳那條路由的說明。 */
interface UploadedFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 現場照片的大小上限。手機拍的照片大多在 3–4 MB，5 MB 夠用又不會塞爆 R2。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
    const id = c.req.param("id");
    const user = c.get("user");

    /*
     * 先把 R2 上的照片抓出來再刪倉位。zone_images 是 cascade，倉位一刪索引就沒了，
     * 那時候就再也不知道該去 R2 刪哪些檔案——只能留下一堆沒人參照的檔案。
     */
    const keys = await zoneImageKeys(c.get("db"), id);
    await deleteZone(c.get("db"), id, { id: user.id, email: user.email });
    if (keys.length && c.env.UPLOADS) {
      // 倉位已經刪掉了，這裡失敗只是多留幾個檔案，不該讓整個請求變成錯誤。
      await Promise.all(keys.map((key) => c.env.UPLOADS!.delete(key).catch(() => {})));
    }
    return c.json({ ok: true });
  })

  // ───────────────────────── 倉位現場照片 ─────────────────────────

  .get("/zones/:id/images", requirePermission("wms:map:read"), async (c) => {
    const images = await listZoneImages(c.get("db"), c.req.param("id"));
    return c.json({ images });
  })

  /**
   * 上傳一張照片。
   *
   * 先寫 R2 再寫 D1：反過來的話，D1 會有一筆指向不存在的檔案，畫面上就是一張
   * 永遠載不出來的破圖。R2 成功但 D1 失敗只是留下一個沒人參照的檔案，
   * 那個安靜得多，也不會讓使用者看到壞掉的東西。
   */
  .post("/zones/:id/images", requirePermission("wms:map:write"), async (c) => {
    const bucket = c.env.UPLOADS;
    if (!bucket) throw new HTTPException(503, { message: "尚未設定照片儲存空間，請聯絡管理者。" });

    const zoneId = c.req.param("id");
    const form = await c.req.formData();
    /*
     * 不用 `instanceof File`：@cloudflare/workers-types 只把 File 宣告成型別、
     * 沒有對應的值，instanceof 會編譯失敗；而 formData().get() 又被宣告成只回
     * 字串，直接讀 .size 也過不了。所以自己描述一個「檔案長什麼樣」再轉型。
     */
    const file = form.get("file") as unknown as UploadedFile | string | null;
    if (!file || typeof file === "string") throw new HTTPException(400, { message: "請選擇一張照片。" });
    if (!file.type.startsWith("image/")) throw new HTTPException(400, { message: "只能上傳圖片檔。" });
    if (file.size > MAX_IMAGE_BYTES) {
      throw new HTTPException(400, { message: `照片不能超過 ${MAX_IMAGE_BYTES / 1024 / 1024} MB。` });
    }

    // 副檔名只留英數，key 會被拿去接路徑。
    const extension = file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "img";
    const objectKey = `zones/${zoneId}/${crypto.randomUUID()}.${extension}`;
    await bucket.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { zoneId, filename: file.name },
    });

    const user = c.get("user");
    const result = await recordZoneImage(c.get("db"), {
      zoneId,
      objectKey,
      filename: file.name,
      contentType: file.type,
      size: file.size,
      actor: { id: user.id, email: user.email },
    });
    return c.json(result, 201);
  })

  /**
   * 讀一張照片。
   *
   * 走 Worker 而不是給一個 R2 的公開網址：照片是倉庫內部的東西，公開網址等於
   * 拿到連結的人都看得到。這裡每次都會經過 requireAuth 與權限檢查。
   */
  .get("/images/:id", requirePermission("wms:map:read"), async (c) => {
    const bucket = c.env.UPLOADS;
    if (!bucket) throw new HTTPException(503, { message: "尚未設定照片儲存空間。" });

    const image = await findZoneImage(c.get("db"), c.req.param("id"));
    if (!image) throw new HTTPException(404, { message: "找不到這張照片。" });

    const object = await bucket.get(image.objectKey);
    if (!object) throw new HTTPException(404, { message: "照片的檔案已經不在了。" });

    return new Response(object.body, {
      headers: {
        "Content-Type": image.contentType || "application/octet-stream",
        // 內容不會變（key 帶 uuid），但仍然是私有的，只讓瀏覽器自己快取。
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  })

  .delete("/images/:id", requirePermission("wms:map:write"), async (c) => {
    const user = c.get("user");
    const { objectKey } = await deleteZoneImage(c.get("db"), c.req.param("id"), {
      id: user.id,
      email: user.email,
    });
    // D1 先刪：這裡失敗只是 R2 多一個沒人參照的檔案，反過來會留下破圖。
    if (c.env.UPLOADS) await c.env.UPLOADS.delete(objectKey).catch(() => {});
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
