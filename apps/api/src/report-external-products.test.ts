import {
  createDatabase,
  ignoreReportExternalProduct,
  resolveReportExternalProduct,
  schema,
  unignoreReportExternalProduct,
} from "@rueisiang/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }
const ACTOR = { id: "external-product-test", email: "manager@example.com" };

beforeEach(() => {
  d1 = createLocalD1();
});

describe("報表外部商品管理", () => {
  it("可以對應、忽略與取消忽略外部商品", async () => {
    const itemId = "external-product-item";
    await db().insert(schema.items).values({ id: itemId, source: "custom", kind: "sellable", sku: "ITEM-001", name: "測試品項", active: 1 });
    await db().insert(schema.reportExternalProducts).values({
      id: "external-product-1",
      sourceType: "cyberbiz",
      externalKey: "EXT-001",
      externalVariantKey: "",
      externalName: "外部測試商品",
      resolution: "ignored",
      itemId: null,
      ignoredReason: "待確認",
    });

    const resolved = await resolveReportExternalProduct(db(), { id: "external-product-1", itemId, actor: ACTOR });
    expect(resolved).toMatchObject({ resolution: "mapped", itemId, ignoredReason: "" });

    const ignored = await ignoreReportExternalProduct(db(), { id: resolved.id, reason: "不納入統計", actor: ACTOR });
    expect(ignored).toMatchObject({ resolution: "ignored", itemId: null, ignoredReason: "不納入統計" });

    await unignoreReportExternalProduct(db(), { id: resolved.id, actor: ACTOR });
    expect(await db().select().from(schema.reportExternalProducts).where(eq(schema.reportExternalProducts.id, resolved.id))).toEqual([]);
  });
});
