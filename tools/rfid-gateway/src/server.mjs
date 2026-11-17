import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { pathToFileURL } from "node:url";

const FRAME_LIMIT = 256;
const PENDING_FRAME_LIMIT = 8;
const UPSTREAM_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [200, 500];
// Reader 在卡片停留期間可能重送相同列；避免一次感應連續翻轉上下班狀態。
const DUPLICATE_FRAME_WINDOW_MS = 3_000;

function log(logger, event, fields = {}) {
  logger({ service: "rfid-gateway", event, ...fields });
}

function validateConfig(config) {
  const apiOrigin = new URL(config.apiOrigin);
  if (apiOrigin.protocol !== "https:" || apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
    throw new Error("RFID_API_ORIGIN 必須是 HTTPS origin，不可包含路徑、query 或 fragment。");
  }
  if (typeof config.token !== "string" || config.token.length < 32) {
    throw new Error("RFID_GATEWAY_TOKEN 必須至少有 32 個字元。");
  }
  if (typeof config.deviceId !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(config.deviceId)) {
    throw new Error("RFID_DEVICE_ID 必須是 1–100 個英數字、點、底線或連字號。");
  }
  if (typeof config.attendanceLocationName !== "string" || !config.attendanceLocationName.trim() || config.attendanceLocationName.length > 100) {
    throw new Error("RFID_ATTENDANCE_LOCATION_NAME 必須是 1–100 個字元的出勤地點名稱。");
  }
  for (const [label, port] of [["LISTEN_PORT", config.listenPort], ["HEALTH_PORT", config.healthPort]]) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${label} 必須是 0–65535 的整數。`);
  }
  return { ...config, apiUrl: new URL("/api/internal/rfid/scans", apiOrigin).toString() };
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

async function forwardFrame(rawPacket, config, fetchImpl) {
  const scanId = randomUUID();
  let lastError;
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(config.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rfid-gateway-token": config.token,
        },
        body: JSON.stringify({ deviceId: config.deviceId, scanId, attendanceLocationName: config.attendanceLocationName, rawPacket }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!retryableStatus(response.status) || attempt === UPSTREAM_ATTEMPTS - 1) return response.status;
      await response.body?.cancel();
      lastError = new Error(`upstream_http_${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === UPSTREAM_ATTEMPTS - 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
  throw lastError ?? new Error("upstream_unavailable");
}

export function createRfidGateway({
  apiOrigin,
  token,
  deviceId = "office-entrance",
  attendanceLocationName = "瑞香雲林總部",
  listenHost = "0.0.0.0",
  listenPort = 6000,
  healthHost = "0.0.0.0",
  healthPort = 8788,
  fetchImpl = fetch,
  now = Date.now,
  logger = (event) => console.log(JSON.stringify(event)),
} = {}) {
  const config = validateConfig({ apiOrigin, token, deviceId, attendanceLocationName, listenPort, healthPort });
  const sockets = new Set();
  const recentFrames = new Map();
  const healthServer = createHttpServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });

  const tcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    let pending = Promise.resolve();
    let pendingFrames = 0;

    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > FRAME_LIMIT && buffered.indexOf(0x0a) < 0) {
        log(logger, "frame_too_large", { deviceId: config.deviceId });
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffered.indexOf(0x0a)) >= 0) {
        const frame = buffered.subarray(0, newline + 1);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > FRAME_LIMIT) {
          log(logger, "frame_too_large", { deviceId: config.deviceId });
          continue;
        }
        if (frame.length === 1) continue;
        if (pendingFrames >= PENDING_FRAME_LIMIT) {
          log(logger, "upstream_queue_full", { deviceId: config.deviceId });
          socket.destroy();
          return;
        }
        const rawPacket = frame.toString("utf8");
        const scannedAt = now();
        for (const [recentPacket, previousScan] of recentFrames) {
          if (scannedAt - previousScan >= DUPLICATE_FRAME_WINDOW_MS) recentFrames.delete(recentPacket);
        }
        const previousScan = recentFrames.get(rawPacket);
        if (previousScan !== undefined && scannedAt - previousScan < DUPLICATE_FRAME_WINDOW_MS) {
          recentFrames.set(rawPacket, scannedAt);
          log(logger, "duplicate_frame_ignored", { deviceId: config.deviceId });
          continue;
        }
        recentFrames.delete(rawPacket);
        recentFrames.set(rawPacket, scannedAt);
        if (recentFrames.size > 512) recentFrames.delete(recentFrames.keys().next().value);
        pendingFrames += 1;
        pending = pending.then(async () => {
          try {
            const status = await forwardFrame(rawPacket, config, fetchImpl);
            log(logger, status >= 200 && status < 300 ? "frame_forwarded" : "upstream_rejected_frame", {
              deviceId: config.deviceId,
              status,
            });
          } catch {
            log(logger, "upstream_failed_frame", { deviceId: config.deviceId });
          } finally {
            pendingFrames -= 1;
          }
        });
      }
      if (buffered.length > FRAME_LIMIT) {
        log(logger, "frame_too_large", { deviceId: config.deviceId });
        socket.destroy();
      }
    });

    socket.on("close", () => {
      if (buffered.length > 0) log(logger, "partial_frame_discarded", { deviceId: config.deviceId });
    });
    socket.on("error", () => log(logger, "tcp_client_error", { deviceId: config.deviceId }));
  });

  return {
    tcpServer,
    healthServer,
    listen() {
      tcpServer.listen(config.listenPort, listenHost);
      healthServer.listen(config.healthPort, healthHost);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const server of [tcpServer, healthServer]) {
        if (!server.listening) continue;
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}

export function configFromEnv(env = process.env) {
  const listenPort = Number(env.LISTEN_PORT ?? 6000);
  const healthPort = Number(env.HEALTH_PORT ?? 8788);
  return {
    apiOrigin: env.RFID_API_ORIGIN,
    token: env.RFID_GATEWAY_TOKEN,
    deviceId: env.RFID_DEVICE_ID ?? "office-entrance",
    attendanceLocationName: env.RFID_ATTENDANCE_LOCATION_NAME ?? "瑞香雲林總部",
    listenHost: env.LISTEN_HOST ?? "0.0.0.0",
    listenPort,
    healthHost: env.HEALTH_HOST ?? "0.0.0.0",
    healthPort,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = createRfidGateway(configFromEnv());
  gateway.listen();
  log((event) => console.log(JSON.stringify(event)), "started", {
    listenPort: configFromEnv().listenPort,
    healthPort: configFromEnv().healthPort,
    deviceId: configFromEnv().deviceId,
  });
  const stop = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
