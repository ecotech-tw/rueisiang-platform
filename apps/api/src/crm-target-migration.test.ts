import { describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

describe("CRM target schema", () => {
  it("移除舊來源／JSON 欄位與 customers 相容 view，並建立 target 索引", () => {
    const d1 = createTargetOnlyD1();
    const customerColumns = new Set(
      (d1.sqlite.prepare("PRAGMA table_info(crm_customers)").all() as { name: string }[])
        .map((column) => column.name),
    );
    const view = d1.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'customers'")
      .get();
    const savedViewColumns = new Set(
      (d1.sqlite.prepare("PRAGMA table_info(crm_saved_views)").all() as { name: string }[])
        .map((column) => column.name),
    );
    const indexes = new Set(
      (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
        .map((index) => index.name),
    );

    expect([...customerColumns]).not.toEqual(expect.arrayContaining([
      "source_channel",
      "cyberbiz_tags_json",
      "sync_error",
      "last_webhook_at",
    ]));
    expect(view).toBeUndefined();
    expect(savedViewColumns.has("channel")).toBe(false);
    for (const index of [
      "idx_crm_customers_cyberbiz_customer_id",
      "idx_crm_customers_phone",
      "idx_crm_customers_status",
      "idx_crm_customers_updated",
      "idx_crm_customers_cb_updated",
      "idx_crm_customers_incomplete",
    ]) expect(indexes).toContain(index);
  });
});
