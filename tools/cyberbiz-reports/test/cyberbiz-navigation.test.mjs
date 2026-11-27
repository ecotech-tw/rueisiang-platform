import assert from "node:assert/strict";
import test from "node:test";
import { dismissOverlays, isCloudflareChallengePage, navigateToAdmin, PRODUCT_SALES_REPORT_LINK_NAME, resolveStore, waitForLoginOutcome } from "../lib/cyberbiz.mjs";

test("商品銷售報表連結名稱允許後台插入空白或換行", () => {
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品銷售\n總表"), true);
  assert.equal(PRODUCT_SALES_REPORT_LINK_NAME.test("商品 銷售 報表"), true);
});

function pageWithNavigationTimeout(status) {
  const frame = {};
  let responseHandler;
  return {
    mainFrame: () => frame,
    on: (event, handler) => { if (event === "response") responseHandler = handler; },
    off: (event, handler) => { if (event === "response" && responseHandler === handler) responseHandler = undefined; },
    goto: async (url, options) => {
      assert.equal(url, "https://rueisiang.cyberbiz.co/admin/pos_shops");
      assert.equal(options.waitUntil, "domcontentloaded");
      if (status !== undefined) {
        responseHandler({
          request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
          status: () => status,
        });
      }
      throw Object.assign(new Error("Timeout 30000ms exceeded"), { name: "TimeoutError" });
    },
  };
}

test("CYBERBIZ 導航逾時會指出主文件回應狀態，不記錄頁面內容", async () => {
  await assert.rejects(
    navigateToAdmin(pageWithNavigationTimeout(200), "https://rueisiang.cyberbiz.co"),
    (error) => error.code === "CYBERBIZ_NAVIGATION_TIMEOUT"
      && error.message.includes("主文件 HTTP 200")
      && !error.message.includes("頁面內容"),
  );
  await assert.rejects(
    navigateToAdmin(pageWithNavigationTimeout(undefined), "https://rueisiang.cyberbiz.co"),
    (error) => error.code === "CYBERBIZ_NAVIGATION_TIMEOUT"
      && error.message.includes("尚未收到主文件回應"),
  );
});

test("resolveStore 的管理頁導航也使用逾時診斷", async () => {
  await assert.rejects(
    resolveStore(pageWithNavigationTimeout(503), {
      origin: "https://rueisiang.cyberbiz.co",
      storeName: "測試店",
    }),
    (error) => error.code === "CYBERBIZ_NAVIGATION_TIMEOUT"
      && error.message.includes("主文件 HTTP 503"),
  );
});

test("只分類 Cloudflare 驗證頁，不記錄頁面內容", async () => {
  const pageFor = ({ selectorVisible = false, title = "", body = "" } = {}) => ({
    locator: (selector) => selector === "body"
      ? { innerText: async () => body }
      : { first: () => ({ isVisible: async () => selectorVisible }) },
    title: async () => title,
  });

  assert.equal(await isCloudflareChallengePage(pageFor({ title: "Just a moment", body: "Verifying... CLOUDFLARE" })), true);
  assert.equal(await isCloudflareChallengePage(pageFor({ selectorVisible: true })), true);
  assert.equal(await isCloudflareChallengePage(pageFor({ title: "CYBERBIZ", body: "登入" })), false);
});

test("登入結果會等待導頁、POS 商店、2FA 或 Cloudflare 挑戰狀態", async () => {
  const never = () => new Promise(() => {});
  const textWaiter = () => ({ first: () => ({ waitFor: never }) });
  const twoFactorPage = {
    waitForURL: never,
    getByText: textWaiter,
    locator: (selector) => ({
      first: () => ({
        waitFor: async ({ state }) => {
          assert.equal(state, "visible");
          if (selector === "#otp_attempt, input[autocomplete='one-time-code'], input[name*='otp']") return;
          return never();
        },
      }),
    }),
  };
  assert.equal(await waitForLoginOutcome(twoFactorPage, { timeout: 10 }), "two_factor");

  const posPageWithoutRedirect = {
    waitForURL: never,
    getByText: textWaiter,
    locator: (selector) => ({
      first: () => ({
        waitFor: async () => selector === "a[href^='/admin/pos_shops/']" ? undefined : never(),
      }),
    }),
  };
  assert.equal(await waitForLoginOutcome(posPageWithoutRedirect, { timeout: 10 }), "signed_in");

  const challengePage = {
    waitForURL: never,
    getByText: () => ({ first: () => ({ waitFor: async () => {} }) }),
    locator: () => ({ first: () => ({ waitFor: never }) }),
  };
  assert.equal(await waitForLoginOutcome(challengePage, { timeout: 10 }), "cloudflare_challenge");

  const signedInPage = {
    waitForURL: async (predicate) => {
      assert.equal(predicate(new URL("https://rueisiang.cyberbiz.co/admin/pos_shops")), true);
    },
    getByText: textWaiter,
    locator: () => ({ first: () => ({ waitFor: never }) }),
  };
  assert.equal(await waitForLoginOutcome(signedInPage, { waitForTwoFactor: false, timeout: 10 }), "signed_in");

  const timeoutError = () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
  const timeoutPage = {
    waitForURL: async () => timeoutError(),
    getByText: () => ({ first: () => ({ waitFor: async () => timeoutError() }) }),
    locator: () => ({ first: () => ({ waitFor: async () => timeoutError() }) }),
  };
  assert.equal(await waitForLoginOutcome(timeoutPage, { timeout: 10 }), null);
});

test("關閉覆蓋頁面的 CYBERBIZ 通知 iframe，不碰其他 iframe", async () => {
  const removed = [];
  const log = [];
  const page = {
    locator(selector) {
      if (selector === 'iframe[src*="/admin/shop_notifications/"]') {
        return {
          count: async () => 2,
          evaluateAll: async (callback) => callback([
            { remove: () => removed.push(0) },
            { remove: () => removed.push(1) },
          ]),
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
