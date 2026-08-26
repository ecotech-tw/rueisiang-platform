import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_SALES_REPORT_LINK_NAME } from "../lib/cyberbiz.mjs";

test("商品銷售報表連結名稱允許後台插入空白或換行", () => {
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品銷售\n總表"), true);
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品 銷售 報表"), true);
});
