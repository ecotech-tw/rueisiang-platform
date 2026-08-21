import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * 舊 WMS 的資料匯入腳本。
 *
 * 這不是在測「SQL 字串長得對不對」——是把產生出來的 SQL **真的套到一個跑完所有
 * migration 的資料庫上**，然後查回來看。資料搬遷是不可逆的，「看起來對」不夠。
 */

const SCRIPT = path.resolve(import.meta.dirname, "../../../packages/db/scripts/import-wms.mjs");

/** 一份涵蓋各種邊角的假 dashboard 回應。 */
const DASHBOARD = {
  settings: { canvasWidth: 2200, canvasHeight: 1200 },
  categories: [
    { id: "c1", name: "一般 清潔/油膏", color: "sky", createdAt: "2026-06-01 10:00:00", updatedAt: "2026-06-01 10:00:00" },
    { id: "c2", name: "包材耗材", color: "amber", createdAt: "2026-06-01 10:00:00", updatedAt: "2026-06-01 10:00:00" },
  ],
  zones: [
    {
      id: "z1", code: "A006", name: "醬菜類", category: "一般備品", color: "sky",
      x: 8, y: 10, width: 20, height: 18,
      shelfLevels: [{ id: "top", name: "板模1" }, { id: "mid", name: "板模2" }],
      // 兩個都是真的踩過的：單引號要跳脫，換行不能留在常值裡（見 quote() 的註解）
      notes: "老闆說 'don't touch'\n第二行：不要動", createdAt: "2026-06-01 10:00:00", updatedAt: "2026-07-01 10:00:00",
    },
    { id: "z2", code: "D001", name: "包裝耗材", category: "包材", color: "sand", x: 40, y: 10, width: 25, height: 14, shelfLevels: [], notes: "", createdAt: null, updatedAt: null },
  ],
  layoutElements: [
    { id: "e1", label: "出貨口", color: "rose", x: 70, y: 8, width: 12, height: 10, createdAt: "2026-06-01 10:00:00", updatedAt: "2026-06-01 10:00:00" },
  ],
  items: [
    {
      id: "i1", sku: "ABALL001", name: "輕鬆起泡沐浴球", category: "一般 清潔/油膏",
      quantity: 24394, unit: "件", minStock: 3000, zoneId: "z1", shelfLevel: "top",
      notes: "", createdAt: "2026-06-01 10:00:00", updatedAt: "2026-08-01 10:00:00",
      cyberbizProductId: "57336636", cyberbizVariantId: "69243235",
      cyberbizSyncStatus: "synced", cyberbizLastSyncedAt: "2026-08-01 10:00:00", cyberbizLastError: "",
    },
    // 沒有 SKU：舊系統回空字串，平台這邊要存 NULL
    { id: "i2", sku: "", name: "沒有 SKU 的東西", category: "包材耗材", quantity: 0, unit: "個", minStock: 5, zoneId: null, shelfLevel: null, notes: "", createdAt: null, updatedAt: null, cyberbizProductId: null, cyberbizVariantId: null },
    { id: "i3", sku: "TAPE-01", name: "封箱膠帶", category: "包材耗材", quantity: 48, unit: "捲", minStock: 20, zoneId: "z2", shelfLevel: null, notes: "", createdAt: null, updatedAt: null, cyberbizProductId: null, cyberbizVariantId: null },
  ],
  images: [{ id: "img1", zoneId: "z1", filename: "shelf.jpg", contentType: "image/jpeg", size: 12345, createdAt: "2026-06-01 10:00:00" }],
};

function generate(payload: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wms-import-")), "dashboard.json");
  fs.writeFileSync(file, JSON.stringify(payload));
  return execFileSync("node", [SCRIPT, file], { encoding: "utf8" });
}

/** 把產生的 SQL 套到一個全新的、跑完 migration 的資料庫。 */
function apply(sql: string) {
  const d1 = createLocalD1();
  for (const line of sql.split("\n")) {
    const statement = line.trim();
    if (statement && !statement.startsWith("--")) d1.sqlite.exec(statement);
  }
  return d1;
}

describe("匯入舊 WMS 的資料", () => {
  it("產生的 SQL 真的套得進去，而且內容對得上", () => {
    const d1 = apply(generate(DASHBOARD));
    const all = (text: string) => d1.sqlite.prepare(text).all() as Record<string, unknown>[];

    expect(all("SELECT * FROM product_categories")).toHaveLength(2);
    expect(all("SELECT * FROM zones")).toHaveLength(2);
    expect(all("SELECT * FROM layout_elements")).toHaveLength(1);
    expect(all("SELECT * FROM inventory_items")).toHaveLength(3);

    // 單引號與換行都要活著過來，而且沒有把 SQL 弄斷
    const [zone] = all("SELECT notes, shelf_levels FROM zones WHERE code = 'A006'");
    expect(zone?.notes).toBe("老闆說 'don't touch'\n第二行：不要動");
    expect(JSON.parse(String(zone?.shelf_levels))).toHaveLength(2);

    // 沒有層架的倉位要補上預設的三層，不然商品沒地方放
    const [bare] = all("SELECT shelf_levels FROM zones WHERE code = 'D001'");
    expect(JSON.parse(String(bare?.shelf_levels))).toHaveLength(3);

    // 空字串的 SKU 要變成 NULL：unique 索引會把多個空字串當成重複
    const [noSku] = all("SELECT sku FROM inventory_items WHERE id = 'i2'");
    expect(noSku?.sku).toBeNull();

    // 時間戳沿用舊系統的，不是「現在」
    const [item] = all("SELECT created_at FROM inventory_items WHERE id = 'i1'");
    expect(item?.created_at).toBe("2026-06-01 10:00:00");

    // 畫布尺寸
    expect(all("SELECT canvas_width, canvas_height FROM warehouse_settings")[0])
      .toMatchObject({ canvas_width: 2200, canvas_height: 1200 });
  });

  it("CYBERBIZ 連結會一起重建", () => {
    const d1 = apply(generate(DASHBOARD));
    const links = d1.sqlite.prepare("SELECT * FROM cyberbiz_product_links").all() as Record<string, unknown>[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      inventory_item_id: "i1",
      cyberbiz_variant_id: "69243235",
      sku: "ABALL001",
      warehouse_scope: "company",
    });
  });

  /*
   * 一句 SQL 一行，這是套用端的前提。
   *
   * 真的搬資料時才發現倉位 B003 的備註裡有換行，而 quote() 當時直接把它寫進
   * 常值——SQLite 允許，但逐行讀的套用端會把那句 INSERT 看成兩句壞掉的 SQL。
   * 上面那個「備註有換行」的案例已經會踩到，這裡再直接把規則本身釘住。
   */
  it("每一句 SQL 都在同一行——套用端是逐行讀的", () => {
    for (const line of generate(DASHBOARD).split("\n")) {
      if (line.startsWith("INSERT")) expect(line.endsWith(";")).toBe(true);
    }
  });

  it("照片不匯入——檔案還在 GCS，只搬索引會變成一堆破圖", () => {
    const d1 = apply(generate(DASHBOARD));
    expect(d1.sqlite.prepare("SELECT COUNT(*) c FROM zone_images").get()).toMatchObject({ c: 0 });
  });

  it("重跑一次是安全的：不報錯，也不會變成兩份", () => {
    const sql = generate(DASHBOARD);
    const d1 = apply(sql);
    for (const line of sql.split("\n")) {
      const statement = line.trim();
      if (statement && !statement.startsWith("--")) d1.sqlite.exec(statement);
    }
    expect(d1.sqlite.prepare("SELECT COUNT(*) c FROM inventory_items").get()).toMatchObject({ c: 3 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) c FROM cyberbiz_product_links").get()).toMatchObject({ c: 1 });
  });

  it("參照對不上時整批停下來，不會匯入一半", () => {
    const broken = {
      ...DASHBOARD,
      items: [{ ...DASHBOARD.items[0], zoneId: "不存在的倉位" }],
    };
    // 產生階段就失敗：D1 沒有跨語句的交易可以回滾，留下半滿的資料庫最難處理。
    expect(() => generate(broken)).toThrow();
  });
});
