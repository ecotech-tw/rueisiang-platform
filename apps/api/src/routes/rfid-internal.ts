import { captureHrRfidScan, HrRfidError } from "@rueisiang/db";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { sameSecret } from "../secret.js";

export const rfidInternal = new Hono<AppEnv>()
  .use("*", bodyLimit({ maxSize: 2_048 }))
  .post("/scans", async (c) => {
    if (!c.env.RFID_GATEWAY_TOKEN?.trim()) return c.json({ error: "RFID Gateway 尚未完成伺服器設定。" }, 503);
    if (!await sameSecret(c.req.header("X-RFID-Gateway-Token"), c.env.RFID_GATEWAY_TOKEN)) return c.json({ error: "unauthorized" }, 401);

    let value: unknown;
    try {
      value = await c.req.json<unknown>();
    } catch {
      throw new HTTPException(400, { message: "刷卡資料格式不正確。" });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HTTPException(400, { message: "刷卡資料格式不正確。" });
    const input = value as Record<string, unknown>;
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
    const scanId = input.scanId === undefined ? undefined : typeof input.scanId === "string" ? input.scanId.trim() : "";
    const attendanceLocationName = input.attendanceLocationName === undefined ? undefined : typeof input.attendanceLocationName === "string" ? input.attendanceLocationName.trim() : "";
    const rawPacket = typeof input.rawPacket === "string" ? input.rawPacket : "";
    if (!deviceId || deviceId.length > 100 || (scanId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scanId))
      || (attendanceLocationName !== undefined && (!attendanceLocationName || attendanceLocationName.length > 100)) || !rawPacket || rawPacket.length > 100) {
      throw new HTTPException(400, { message: "讀卡機識別碼、請求識別碼、出勤地點或封包內容不正確。" });
    }

    try {
      const result = await captureHrRfidScan(c.get("db"), { deviceId, scanId, attendanceLocationName, rawPacket });
      return c.json(result, result.captured ? 200 : result.clocked ? result.idempotent ? 200 : 201 : 202);
    } catch (error) {
      if (error instanceof HrRfidError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });
