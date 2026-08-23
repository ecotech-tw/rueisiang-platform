import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  buildUpstreamUrl,
  createRelayServer,
  filterRequestHeaders,
  isAuthorized,
} from "../src/server.mjs";

async function closeServer(server) {
  if (!server.listening) return;
  server.closeIdleConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("relay token uses a timing-safe comparison", () => {
  assert.equal(isAuthorized({ "x-codex-relay-token": "secret" }, "secret"), true);
  assert.equal(isAuthorized({ "x-codex-relay-token": "wrong" }, "secret"), false);
  assert.equal(isAuthorized({}, "secret"), false);
});

test("upstream URL is fixed to the ChatGPT Codex endpoint", () => {
  assert.equal(
    buildUpstreamUrl().toString(),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.throws(
    () => buildUpstreamUrl("https://example.test/backend-api"),
    /chatgpt\.com/,
  );
});

test("Cloudflare and relay-only headers are not forwarded upstream", () => {
  const headers = filterRequestHeaders({
    authorization: "Bearer upstream-token",
    "content-type": "application/json",
    "cf-worker": "platform.example",
    "x-forwarded-for": "203.0.113.1",
    "x-codex-relay-token": "relay-secret",
    host: "relay.example",
  });
  assert.equal(headers.get("authorization"), "Bearer upstream-token");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cf-worker"), null);
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("x-codex-relay-token"), null);
  assert.equal(headers.get("host"), null);
});

test("health check and authenticated SSE proxy work without buffering the response", async () => {
  let observed;
  const logs = [];
  const server = createRelayServer({
    token: "relay-secret",
    logger: (event) => logs.push(event),
    fetchImpl: async (input, init) => {
      if (init?.body && typeof init.body.resume === "function") {
        init.body.resume();
        if (!init.body.readableEnded && !init.body.complete) await once(init.body, "end");
      }
      observed = { input: input.toString(), headers: new Headers(init?.headers) };
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const response = await fetch(`${baseUrl}/codex/responses`, {
      method: "POST",
      headers: {
        "x-codex-relay-token": "relay-secret",
        "cf-worker": "should-be-dropped",
        "x-forwarded-for": "should-be-dropped",
        authorization: "Bearer upstream-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.match(await response.text(), /\[DONE\]/);
    assert.equal(observed.input, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(observed.headers.get("authorization"), "Bearer upstream-token");
    assert.equal(observed.headers.get("cf-worker"), null);
    assert.equal(observed.headers.get("x-forwarded-for"), null);
    assert.equal(observed.headers.get("x-codex-relay-token"), null);
    assert.equal(logs.at(-1).status, 200);
    assert.equal(typeof logs.at(-1).requestId, "string");
  } finally {
    await closeServer(server);
  }
});

test("unauthenticated requests never reach the upstream", async () => {
  let called = false;
  const server = createRelayServer({
    token: "relay-secret",
    fetchImpl: async () => {
      called = true;
      return new Response("unexpected");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/codex/responses`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});
