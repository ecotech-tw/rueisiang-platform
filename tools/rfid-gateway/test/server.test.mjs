import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { createRfidGateway } from "../src/server.mjs";

const TOKEN = "rfid-gateway-test-token-that-is-long-enough";

async function startGateway(options = {}) {
  const logs = [];
  const sent = [];
  const gateway = createRfidGateway({
    apiOrigin: "https://hr.example.com",
    token: TOKEN,
    listenHost: "127.0.0.1",
    listenPort: 0,
    healthHost: "127.0.0.1",
    healthPort: 0,
    logger: (event) => logs.push(event),
    fetchImpl: async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      return new Response(null, { status: 200 });
    },
    ...options,
  });
  gateway.listen();
  await Promise.all([once(gateway.tcpServer, "listening"), once(gateway.healthServer, "listening")]);
  const tcpAddress = gateway.tcpServer.address();
  const healthAddress = gateway.healthServer.address();
  return {
    gateway,
    logs,
    sent,
    tcpPort: tcpAddress.port,
    healthUrl: `http://127.0.0.1:${healthAddress.port}`,
  };
}

async function stopGateway(context, socket) {
  socket?.destroy();
  await context.gateway.close();
}

async function connectReader(port) {
  const socket = connect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for gateway event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("health check is available and does not expose secrets", async () => {
  const context = await startGateway();
  try {
    const response = await fetch(`${context.healthUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await fetch(`${context.healthUrl}/`)).status, 404);
  } finally {
    await stopGateway(context);
  }
});

test("TCP fragments and coalesced CRLF frames are forwarded as exact raw packets", async () => {
  const context = await startGateway();
  const socket = await connectReader(context.tcpPort);
  try {
    socket.write("0002 15");
    socket.write("A9AC63\r\n0002 F1B7E886\r\n");
    await waitFor(() => context.sent.length === 2);

    assert.deepEqual(context.sent.map(({ url, body }) => ({ url, body })), [
      { url: "https://hr.example.com/api/internal/rfid/scans", body: { deviceId: "office-entrance", rawPacket: "0002 15A9AC63\r\n" } },
      { url: "https://hr.example.com/api/internal/rfid/scans", body: { deviceId: "office-entrance", rawPacket: "0002 F1B7E886\r\n" } },
    ]);
    assert.equal(context.sent[0].init.headers["x-rfid-gateway-token"], TOKEN);
    assert.equal(context.logs.some((event) => JSON.stringify(event).includes("15A9AC63")), false);
    assert.equal(context.logs.filter((event) => event.event === "frame_forwarded").length, 2);
  } finally {
    await stopGateway(context, socket);
  }
});

test("transient upstream failures are retried without logging packet contents", async () => {
  let calls = 0;
  const context = await startGateway({
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    },
  });
  const socket = await connectReader(context.tcpPort);
  try {
    socket.write("0002 0F281549\r\n");
    await waitFor(() => context.logs.some((event) => event.event === "frame_forwarded"));
    assert.equal(calls, 2);
    assert.equal(context.logs.some((event) => JSON.stringify(event).includes("0F281549")), false);
  } finally {
    await stopGateway(context, socket);
  }
});

test("invalid HTTP origins and short secrets are rejected", () => {
  assert.throws(() => createRfidGateway({ apiOrigin: "http://hr.example.com", token: TOKEN }), /HTTPS origin/);
  assert.throws(() => createRfidGateway({ apiOrigin: "https://hr.example.com", token: "short" }), /至少有 32 個字元/);
});
