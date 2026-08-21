#!/usr/bin/env node
/**
 * 把舊 WMS（wms.rueisiang.com）的資料轉成可以套用到 D1 的 SQL。
 *
 * 用法：
 *   node packages/db/scripts/import-wms.mjs <dashboard.json> > import.sql
 *
 * 來源是舊系統的 GET /api/dashboard——它一次回傳倉位、標示、分類、商品與
 * CYBERBIZ 連結，剛好就是要搬的東西。這樣做的好處是**不需要 Cloud SQL 的憑證**：
 * 在瀏覽器裡登入舊站、打開那個網址、存成檔案就好。
 *
 * 為什麼是「產生 SQL」而不是「直接寫進去」：
 *
 * 1. 產出的 SQL 進得了 PR，可以逐行看清楚**到底會寫什麼**。資料搬遷是不可逆的，
 *    看不到內容就按下去不是好主意。
 * 2. 這台開發機跑不了 wrangler（Windows on ARM 沒有 workerd），寫入正式 D1 只能
 *    在 CI 上做。SQL 檔正好是交接給 CI 的東西。
 *
 * 全部用 INSERT OR IGNORE：重跑一次是安全的，已經存在的列不會被覆寫也不會報錯。
 * 換句話說這個匯入**只補不改**——已經在平台上編輯過的資料不會被舊資料蓋掉。
 */

import fs from "node:fs";

/** SQLite 的字串常值：單引號要變成兩個。這是唯一需要跳脫的字元。 */
function quote(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

/** 時間戳沿用舊系統的，不要換成現在——那是「這筆資料什麼時候建的」。 */
function timestamp(value) {
  return value ? quote(value) : "CURRENT_TIMESTAMP";
}

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error("用法：node import-wms.mjs <dashboard.json> > import.sql");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const zones = data.zones ?? [];
const elements = data.layoutElements ?? [];
const categories = data.categories ?? [];
const items = data.items ?? [];
const images = data.images ?? [];
const settings = data.settings ?? {};

/*
 * 先檢查參照對不對得上，對不上就整批停下來。
 *
 * 匯入一半再失敗最難處理：D1 沒有跨語句的交易可以回滾整個檔案，留下來的會是
 * 一個半滿的資料庫。寧可在產生 SQL 的階段就擋下來。
 */
const problems = [];
const zoneIds = new Set(zones.map((zone) => zone.id));
const categoryNames = new Set(categories.map((category) => category.name));

for (const item of items) {
  if (item.zoneId && !zoneIds.has(item.zoneId)) {
    problems.push(`商品「${item.name}」指向不存在的倉位 ${item.zoneId}`);
  }
  if (item.category && !categoryNames.has(item.category)) {
    problems.push(`商品「${item.name}」的分類「${item.category}」不在分類清單裡`);
  }
}
for (const image of images) {
  if (!zoneIds.has(image.zoneId)) problems.push(`照片 ${image.filename} 指向不存在的倉位`);
}

if (problems.length) {
  console.error("資料有問題，沒有產生 SQL：");
  for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
  if (problems.length > 20) console.error(`  …另外還有 ${problems.length - 20} 筆`);
  process.exit(1);
}

const out = [];
const say = (line) => out.push(line);

say("-- 從舊 WMS（wms.rueisiang.com）匯入的資料");
say(`-- 產生時間：${new Date().toISOString()}`);
say(`-- 來源：${inputPath}`);
say("--");
say("-- 全部是 INSERT OR IGNORE：重跑安全，而且**只補不改**——已經在平台上");
say("-- 編輯過的資料不會被舊資料蓋掉。");
say("");

// ── 畫布設定 ──────────────────────────────────────────────────────────
say("-- 畫布設定（只有一列）");
say(
  `INSERT OR IGNORE INTO warehouse_settings (id, canvas_width, canvas_height) VALUES ` +
    `('main', ${number(settings.canvasWidth, 1600)}, ${number(settings.canvasHeight, 900)});`,
);
say("");

// ── 商品分類 ──────────────────────────────────────────────────────────
// 分類要先進去：inventory_items.category 存的是名字，雖然沒有外鍵，但沒有對應的
// 分類的話商品在畫面上會屬於一個不存在的分類。
say(`-- 商品分類（${categories.length} 筆）`);
for (const category of categories) {
  say(
    `INSERT OR IGNORE INTO product_categories (id, name, color, created_at, updated_at) VALUES (` +
      `${quote(category.id)}, ${quote(category.name)}, ${quote(category.color || "rose")}, ` +
      `${timestamp(category.createdAt)}, ${timestamp(category.updatedAt)});`,
  );
}
say("");

// ── 倉位 ──────────────────────────────────────────────────────────────
say(`-- 倉位（${zones.length} 筆）`);
for (const zone of zones) {
  // shelfLevels 在 API 回應裡已經被解析成陣列，寫回去要重新序列化。
  const shelfLevels = JSON.stringify(
    Array.isArray(zone.shelfLevels) && zone.shelfLevels.length
      ? zone.shelfLevels
      : [
          { id: "top", name: "上層" },
          { id: "middle", name: "中層" },
          { id: "bottom", name: "底層" },
        ],
  );
  say(
    `INSERT OR IGNORE INTO zones (id, code, name, category, color, x, y, width, height, shelf_levels, notes, created_at, updated_at) VALUES (` +
      `${quote(zone.id)}, ${quote(zone.code)}, ${quote(zone.name)}, ${quote(zone.category || "一般備品")}, ` +
      `${quote(zone.color || "mint")}, ${number(zone.x)}, ${number(zone.y)}, ${number(zone.width, 18)}, ${number(zone.height, 16)}, ` +
      `${quote(shelfLevels)}, ${quote(zone.notes || "")}, ${timestamp(zone.createdAt)}, ${timestamp(zone.updatedAt)});`,
  );
}
say("");

// ── 地圖標示 ──────────────────────────────────────────────────────────
say(`-- 地圖標示（${elements.length} 筆）`);
for (const element of elements) {
  say(
    `INSERT OR IGNORE INTO layout_elements (id, label, color, x, y, width, height, created_at, updated_at) VALUES (` +
      `${quote(element.id)}, ${quote(element.label)}, ${quote(element.color || "slate")}, ` +
      `${number(element.x)}, ${number(element.y)}, ${number(element.width, 12)}, ${number(element.height, 10)}, ` +
      `${timestamp(element.createdAt)}, ${timestamp(element.updatedAt)});`,
  );
}
say("");

// ── 庫存品項 ──────────────────────────────────────────────────────────
say(`-- 庫存品項（${items.length} 筆）`);
for (const item of items) {
  // 舊系統的 sku 用 COALESCE 補成空字串；平台這邊空字串要存回 NULL，
  // 不然 unique 索引會把所有「沒有 SKU」的商品當成重複。
  const sku = item.sku ? quote(item.sku) : "NULL";
  say(
    `INSERT OR IGNORE INTO inventory_items (id, sku, name, category, quantity, unit, min_stock, zone_id, shelf_level, notes, created_at, updated_at) VALUES (` +
      `${quote(item.id)}, ${sku}, ${quote(item.name)}, ${quote(item.category)}, ` +
      `${number(item.quantity)}, ${quote(item.unit || "件")}, ${number(item.minStock, 5)}, ` +
      `${item.zoneId ? quote(item.zoneId) : "NULL"}, ${item.shelfLevel ? quote(item.shelfLevel) : "NULL"}, ` +
      `${quote(item.notes || "")}, ${timestamp(item.createdAt)}, ${timestamp(item.updatedAt)});`,
  );
}
say("");

// ── CYBERBIZ 連結 ─────────────────────────────────────────────────────
/*
 * dashboard 把連結 join 在商品上，但沒有回傳連結自己的 id、sku 與倉別。
 *
 * - id：重新產生。它只是主鍵，沒有人從外面參照它。
 * - sku：用商品的 sku。這正是同步時要比對的那個不變條件，所以萬一舊資料本來就
 *   不一致，第一次同步會把它標成失敗——那是對的行為，不是這裡該猜的事。
 * - 倉別：一律 company。舊系統的連結只做公司倉（見 cyberbiz-wms-sync.ts 的
 *   WHERE warehouse_scope = 'company'）。
 */
const linked = items.filter((item) => item.cyberbizProductId && item.cyberbizVariantId);
say(`-- CYBERBIZ 商品連結（${linked.length} 筆）`);
for (const item of linked) {
  say(
    `INSERT OR IGNORE INTO cyberbiz_product_links (id, inventory_item_id, cyberbiz_product_id, cyberbiz_variant_id, sku, warehouse_scope, pos_shop_id, sync_status, last_synced_at, last_error) VALUES (` +
      `${quote(`link-${item.id}`)}, ${quote(item.id)}, ${quote(item.cyberbizProductId)}, ${quote(item.cyberbizVariantId)}, ` +
      `${quote(item.sku || "")}, 'company', 0, ${quote(item.cyberbizSyncStatus || "synced")}, ` +
      `${item.cyberbizLastSyncedAt ? quote(item.cyberbizLastSyncedAt) : "NULL"}, ${quote(item.cyberbizLastError || "")});`,
  );
}
say("");

/*
 * 現場照片**不匯入**。
 *
 * 檔案在 GCS，平台的照片放 R2，而 R2 還沒開通。只把索引搬過來的話，每一張都會
 * 是一個載不出來的破圖——比沒有照片更糟。
 *
 * 要搬的話順序是：先開 R2 → 把 GCS 的檔案複製過去（object key 要一致）→ 才匯入
 * 這些索引。那是另一件事。
 */
say(`-- 現場照片：${images.length} 張，**沒有匯入**`);
say("-- 檔案在 GCS、平台用 R2，而 R2 還沒開通。只搬索引會變成一堆破圖。");
say("-- 要搬的話：先開 R2 → 複製檔案（object key 要一致）→ 才匯入索引。");
say("");

say("-- 舊系統的 audit_logs（操作歷史）也沒有匯入：dashboard 只回傳最新一筆，");
say("-- 而且舊站還會留著一段時間，要查歷史去那邊查。");

process.stdout.write(`${out.join("\n")}\n`);

console.error(
  [
    "產生完成：",
    `  分類 ${categories.length}`,
    `  倉位 ${zones.length}`,
    `  標示 ${elements.length}`,
    `  商品 ${items.length}`,
    `  CYBERBIZ 連結 ${linked.length}`,
    `  照片 ${images.length}（略過）`,
  ].join("\n"),
);
