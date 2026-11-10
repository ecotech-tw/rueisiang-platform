import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRelayServer, isAuthorized, matchRoute } from "../src/server.mjs";

const TOKEN = "test-cyberbiz-relay-token-that-is-at-least-32-bytes";
let server;
let origin;
const logs = [];
let upstreamCalls = [];

before(async () => {
  server = createRelayServer({
    token: TOKEN,
    logger: (event) => logs.push(event),
    fetchImpl: async (url, init) => {
      upstreamCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ customers: [{ id: 8 }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-total-count": "1", "set-cookie": "should-not-pass" },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("relay secret 比對不受長度差異造成的 timingSafeEqual 例外影響", () => {
  assert.equal(isAuthorized({ "x-cyberbiz-relay-token": TOKEN }, TOKEN), true);
  assert.equal(isAuthorized({ "x-cyberbiz-relay-token": "wrong" }, TOKEN), false);
  assert.equal(isAuthorized({}, TOKEN), false);
  assert.throws(() => createRelayServer({ token: "short" }), /至少 32 bytes/u);
});

test("只允許平台實際使用的 CYBERBIZ API 路徑與 method", () => {
  assert.equal(matchRoute("GET", "/v1/customers")?.name, "customers.list");
  assert.equal(matchRoute("PUT", "/v1/customers/42")?.name, "customers.update");
  assert.equal(matchRoute("POST", "/v1/stock_adjustments")?.name, "inventory.adjust");
  assert.equal(matchRoute("GET", "/v1/customers/42/orders")?.name, "customers.orders");
  assert.equal(matchRoute("DELETE", "/v1/customers/42"), null);
  assert.equal(matchRoute("GET", "/v1/admin/users"), null);
});

test("health check 不觸及 CYBERBIZ，上游回應不轉送 cookie", async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(upstreamCalls.length, 0);
});

test("轉送固定到 CYBERBIZ host，保留 query 與必要驗證，不轉送 relay token", async () => {
  const beforeCount = upstreamCalls.length;
  const response = await fetch(`${origin}/v1/customers?page=2&per_page=1`, {
    headers: {
      accept: "application/json",
      authorization: "Bearer cyberbiz-api-secret",
      "x-cyberbiz-relay-token": TOKEN,
      "cf-connecting-ip": "203.0.113.9",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-total-count"), "1");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { customers: [{ id: 8 }] });

  const call = upstreamCalls[beforeCount];
  assert.equal(call?.url, "https://app-store-api.cyberbiz.io/v1/customers?page=2&per_page=1");
  const headers = new Headers(call?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer cyberbiz-api-secret");
  assert.equal(headers.get("x-cyberbiz-relay-token"), null);
  assert.equal(headers.get("cf-connecting-ip"), null);
  assert.equal(logs.at(-1)?.route, "customers.list");
  assert.equal(JSON.stringify(logs.at(-1)).includes("cyberbiz-api-secret"), false);
  assert.equal(JSON.stringify(logs.at(-1)).includes(TOKEN), false);
});

test("缺少 relay token 或命中未允許路徑時不呼叫上游", async () => {
  const beforeCount = upstreamCalls.length;
  const missingAuth = await fetch(`${origin}/v1/customers`);
  const forbiddenRoute = await fetch(`${origin}/v1/admin/users`, {
    headers: { "x-cyberbiz-relay-token": TOKEN },
  });

  assert.equal(missingAuth.status, 401);
  assert.equal(forbiddenRoute.status, 404);
  assert.equal(upstreamCalls.length, beforeCount);
});

test("CYBERBIZ 上游錯誤狀態與安全錯誤標頭會原樣返回", async () => {
  const errorServer = createRelayServer({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ error: "IP Not Allowed" }), {
      status: 403,
      headers: { "content-type": "application/json", "set-cookie": "private=value" },
    }),
  });
  await new Promise((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
  const errorOrigin = `http://127.0.0.1:${errorServer.address().port}`;
  try {
    const response = await fetch(`${errorOrigin}/v1/customers`, {
      headers: { "x-cyberbiz-relay-token": TOKEN, authorization: "Bearer cyberbiz-api-secret" },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { error: "IP Not Allowed" });
  } finally {
    errorServer.closeAllConnections();
    await new Promise((resolve, reject) => errorServer.close((error) => error ? reject(error) : resolve()));
  }
});
