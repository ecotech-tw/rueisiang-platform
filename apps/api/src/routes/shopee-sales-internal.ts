import { Hono } from "hono";
import type { AppEnv } from "../env.js";

function encoded(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function keyFor(requestId: string, token: string): string {
  return `shopee-sales/${requestId}/${token}.xlsx`;
}

function validPart(value: string): boolean {
  return /^[A-Za-z0-9-]{16,80}$/.test(value);
}

export const shopeeSalesInternal = new Hono<AppEnv>()
  .get("/source/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.query("token") ?? "";
    if (!validPart(requestId) || !validPart(token) || !c.env.UPLOADS) return c.text("Not found", 404);

    const object = await c.env.UPLOADS.get(keyFor(requestId, token));
    if (!object) return c.text("Not found", 404);
    const metadata = object.customMetadata ?? {};
    const expiresAt = Number(metadata.expiresAt ?? 0);
    if (!expiresAt || expiresAt < Date.now()) {
      await c.env.UPLOADS.delete(keyFor(requestId, token));
      return c.text("Expired", 410);
    }

    return new Response(object.body, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(metadata.filename ?? "report.xlsx")}"`,
        "X-Shopee-Report-Password": encoded(metadata.password ?? ""),
        "X-Shopee-Report-Filename": encoded(metadata.filename ?? "report.xlsx"),
        "Cache-Control": "no-store",
      },
    });
  })
  .post("/cleanup/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.query("token") ?? "";
    if (!validPart(requestId) || !validPart(token) || !c.env.UPLOADS) return c.text("Not found", 404);
    await c.env.UPLOADS.delete(keyFor(requestId, token));
    return c.json({ ok: true });
  });
