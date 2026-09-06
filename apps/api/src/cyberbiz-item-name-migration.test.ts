import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { formatCyberbizProductName } from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

const DEDUPE = "0098_cyberbiz_item_name_dedupe.sql";

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

/*
 * 官網回傳的 variant_name 本身就是「商品名 - 規格」，這些字串直接取自正式庫：
 * 單一款式的商品規格是空的，只剩一個尾巴的連字號。
 */
function seed(sqlite: DatabaseSync, input: { id: string; sku: string; name: string; productName: string; variantName: string }): void {
  sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, active) VALUES (?, 'cyberbiz', 'sellable', ?, ?, 1)")
    .run(input.id, input.sku, input.name);
  sqlite.prepare(
    "INSERT INTO cyberbiz_products (item_id, cyberbiz_product_id, cyberbiz_variant_id, product_name, variant_name) VALUES (?, ?, ?, ?, ?)",
  ).run(input.id, `p-${input.sku}`, `v-${input.sku}`, input.productName, input.variantName);
}

const nameOf = (sqlite: DatabaseSync, id: string): string =>
  (sqlite.prepare("SELECT name FROM items WHERE id = ?").get(id) as { name: string }).name;

describe("formatCyberbizProductName 不重複商品名", () => {
  it("款式名只是商品名加一個空規格時，只留商品名", () => {
    expect(formatCyberbizProductName({ productName: "★賦活草本液體皂", variantName: "★賦活草本液體皂 -" }))
      .toBe("★賦活草本液體皂");
  });

  it("有真正的規格時只保留規格那一段", () => {
    expect(formatCyberbizProductName({ productName: "洗護合一組", variantName: "洗護合一組 - 黑豆液體皂 + 護髮素" }))
      .toBe("洗護合一組（黑豆液體皂 + 護髮素）");
  });

  it("商品名自己含連字號也只切掉前綴", () => {
    expect(formatCyberbizProductName({ productName: "統一手工麻花捲-草莓煉乳", variantName: "統一手工麻花捲-草莓煉乳 -" }))
      .toBe("統一手工麻花捲-草莓煉乳");
  });

  it("款式名沒有商品名前綴時原樣保留——官網改格式時寧可囉唆也不要亂切", () => {
    expect(formatCyberbizProductName({ productName: "城市帆布袋", variantName: "大款" }))
      .toBe("城市帆布袋（大款）");
  });

  it("款式名是空白時不留下空括號", () => {
    expect(formatCyberbizProductName({ productName: "城市帆布袋", variantName: "   " })).toBe("城市帆布袋");
  });
});

describe("0098 清掉既有品項名稱裡重複的商品名", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    applyLikeD1(sqlite, null, "0097_webhook_events_entity_type.sql");
  });

  it("機器產的名字改乾淨，人改過的原封不動", () => {
    seed(sqlite, {
      id: "item-single", sku: "SOAP-01", name: "★賦活草本液體皂（★賦活草本液體皂 -）",
      productName: "★賦活草本液體皂", variantName: "★賦活草本液體皂 -",
    });
    seed(sqlite, {
      id: "item-variant", sku: "SET-01", name: "洗護合一組（洗護合一組 - 黑豆液體皂 + 護髮素）",
      productName: "洗護合一組", variantName: "洗護合一組 - 黑豆液體皂 + 護髮素",
    });
    // 舊的連字號版本也要認得：更早的同步是用「商品名 - 款式名」串的。
    seed(sqlite, {
      id: "item-dash", sku: "BAG-01", name: "城市帆布袋 - 城市帆布袋 - 大款",
      productName: "城市帆布袋", variantName: "城市帆布袋 - 大款",
    });
    seed(sqlite, {
      id: "item-renamed", sku: "GIFT-01", name: "端午禮盒（倉庫叫這個）",
      productName: "香入菲菲經典5入禮盒", variantName: "香入菲菲經典5入禮盒 - 黑豆+黑豆",
    });

    applyLikeD1(sqlite, "0097_webhook_events_entity_type.sql", DEDUPE);

    expect(nameOf(sqlite, "item-single")).toBe("★賦活草本液體皂");
    expect(nameOf(sqlite, "item-variant")).toBe("洗護合一組（黑豆液體皂 + 護髮素）");
    expect(nameOf(sqlite, "item-dash")).toBe("城市帆布袋（大款）");
    expect(nameOf(sqlite, "item-renamed")).toBe("端午禮盒（倉庫叫這個）");
  });

  it("不碰非官網來源的品項", () => {
    sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, active) VALUES ('item-custom', 'custom', 'material', 'MAT-01', '紙箱 - 紙箱', 1)").run();

    applyLikeD1(sqlite, "0097_webhook_events_entity_type.sql", DEDUPE);

    expect(nameOf(sqlite, "item-custom")).toBe("紙箱 - 紙箱");
  });
});
