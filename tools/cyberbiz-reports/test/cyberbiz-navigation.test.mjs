import assert from "node:assert/strict";
import test from "node:test";
import { dismissOverlays, PRODUCT_SALES_REPORT_LINK_NAME } from "../lib/cyberbiz.mjs";

test("商品銷售報表連結名稱允許後台插入空白或換行", () => {
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品銷售\n總表"), true);
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品 銷售 報表"), true);
});

test("關閉覆蓋頁面的 CYBERBIZ 通知 iframe，不碰其他 iframe", async () => {
  const removed = [];
  const log = [];
  const page = {
    locator(selector) {
      if (selector === 'iframe[src*="/admin/shop_notifications/"]') {
        return {
          count: async () => 2,
          nth: (index) => ({ evaluate: async (callback) => {
            removed.push(index);
            callback({ remove() {} });
          } }),
        };
      }
      return { first: () => ({ isVisible: async () => false }) };
    },
    waitForTimeout: async () => {},
  };

  assert.equal(await dismissOverlays(page, { log: (message) => log.push(message) }), true);
  assert.deepEqual(removed, [0, 1]);
  assert.deepEqual(log, ["移除 2 個 CYBERBIZ 通知遮罩"]);
});
