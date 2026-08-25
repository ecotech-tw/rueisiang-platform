import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildObjectKey, createStorageServer, isAuthorized } from "../src/server.mjs";

async function startServer(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rueisiang-nas-storage-"));
  const server = createStorageServer({ root, token: "storage-secret", fetchLogger: () => {}, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { root, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer({ root, server }) {
  server.closeIdleConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}

function objectUrl(baseUrl, key) {
  const params = new URLSearchParams({ key });
  return `${baseUrl}/v1/objects?${params}`;
}

test("storage token uses a timing-safe comparison", () => {
  assert.equal(isAuthorized({ "x-storage-token": "secret" }, "secret"), true);
  assert.equal(isAuthorized({ "x-storage-token": "wrong" }, "secret"), false);
  assert.equal(isAuthorized({}, "secret"), false);
});

test("object keys are generated inside the allowed namespace layouts", () => {
  const now = new Date("2026-08-24T08:00:00.000Z");
  assert.match(
    buildObjectKey({ namespace: "assistant", scope: "vision", scopeId: "sandbox-chat", contentType: "image/jpeg", now }),
    /^assistant\/vision\/sandbox-chat\/2026\/08\/[0-9a-f-]+\.jpg$/,
  );
  assert.match(
    buildObjectKey({ namespace: "wms", scope: "zones", scopeId: "zone-a", contentType: "image/png", now }),
    /^wms\/zones\/zone-a\/2026\/08\/[0-9a-f-]+\.png$/,
  );
  assert.throws(
    () => buildObjectKey({ namespace: "assistant", scope: "vision", contentType: "image/jpeg", now }),
    /儲存 namespace 或 scope/,
  );
  assert.throws(
    () => buildObjectKey({ namespace: "assistant", scope: "vision", scopeId: "../secret", contentType: "image/jpeg", now }),
    /儲存 namespace 或 scope/,
  );
});

test("health is public but object writes require the separate storage token", async () => {
  const context = await startServer();
  try {
    const health = await fetch(`${context.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const response = await fetch(`${context.baseUrl}/v1/objects?namespace=assistant&scope=vision&scopeId=chat-a`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: Buffer.from("private image"),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "unauthorized",
      message: "未授權的儲存請求。 ",
    });
  } finally {
    await stopServer(context);
  }
});

test("upload, head, download and delete use the generated key", async () => {
  const context = await startServer({ now: () => new Date("2026-08-24T08:00:00.000Z") });
  try {
    const payload = Buffer.from("private jpeg bytes");
    const upload = await fetch(`${context.baseUrl}/v1/objects?namespace=assistant&scope=vision&scopeId=chat-a`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "x-storage-token": "storage-secret",
      },
      body: payload,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    const object = uploaded.object;
    assert.match(object.key, /^assistant\/vision\/chat-a\/2026\/08\/[0-9a-f-]+\.jpg$/);
    assert.equal(object.contentType, "image/jpeg");
    assert.equal(object.size, payload.length);
    assert.equal(object.checksum.length, 64);

    const storedPath = path.join(context.root, ...object.key.split("/"));
    assert.deepEqual(await readFile(storedPath), payload);

    const head = await fetch(objectUrl(context.baseUrl, object.key), {
      method: "HEAD",
      headers: { "x-storage-token": "storage-secret" },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(payload.length));
    assert.equal(head.headers.get("content-type"), "image/jpeg");

    const download = await fetch(objectUrl(context.baseUrl, object.key), {
      headers: { "x-storage-token": "storage-secret" },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload);

    const deletion = await fetch(objectUrl(context.baseUrl, object.key), {
      method: "DELETE",
      headers: { "x-storage-token": "storage-secret" },
    });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { key: object.key, ok: true });
    await assert.rejects(() => stat(storedPath), { code: "ENOENT" });
  } finally {
    await stopServer(context);
  }
});

test("WMS uploads require a safe zone id and path traversal never reaches the filesystem", async () => {
  const context = await startServer({ now: () => new Date("2026-08-24T08:00:00.000Z") });
  try {
    const upload = await fetch(`${context.baseUrl}/v1/objects?namespace=wms&scope=zones&scopeId=zone-a`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-storage-token": "storage-secret",
      },
      body: Buffer.from("zone image"),
    });
    assert.equal(upload.status, 201);
    const { object } = await upload.json();
    assert.match(object.key, /^wms\/zones\/zone-a\/2026\/08\/[0-9a-f-]+\.png$/);

    const traversal = await fetch(objectUrl(context.baseUrl, "../outside"), {
      headers: { "x-storage-token": "storage-secret" },
    });
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).error, "invalid_object_key");

    const invalidZone = await fetch(`${context.baseUrl}/v1/objects?namespace=wms&scope=zones&scopeId=../secret`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-storage-token": "storage-secret",
      },
      body: Buffer.from("zone image"),
    });
    assert.equal(invalidZone.status, 400);
  } finally {
    await stopServer(context);
  }
});

test("unsupported formats and oversized bodies are rejected before they become objects", async () => {
  const context = await startServer({ maxObjectBytes: 4 });
  try {
    const typeError = await fetch(`${context.baseUrl}/v1/objects?namespace=assistant&scope=vision&scopeId=chat-a`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-storage-token": "storage-secret",
      },
      body: Buffer.from("text"),
    });
    assert.equal(typeError.status, 415);

    const tooLarge = await fetch(`${context.baseUrl}/v1/objects?namespace=assistant&scope=vision&scopeId=chat-a`, {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        "x-storage-token": "storage-secret",
      },
      body: Buffer.from("12345"),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await readdir(context.root), []);
  } finally {
    await stopServer(context);
  }
});
