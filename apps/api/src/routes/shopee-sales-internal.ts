import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { shopeePreviewKey, type ShopeePreview } from "../shopee-sales/preview.js";

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
  .post("/preview/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.header("x-shopee-preview-token") ?? "";
    if (!validPart(requestId) || !validPart(token) || !c.env.UPLOADS) return c.text("Not found", 404);

    const key = shopeePreviewKey(requestId, token);
    const current = await c.env.UPLOADS.get(key);
    if (!current) return c.text("Not found", 404);
    const metadata = current.customMetadata ?? {};
    if (Number(metadata.expiresAt ?? 0) < Date.now()) {
      await c.env.UPLOADS.delete(key);
      return c.text("Expired", 410);
    }
    let preview: ShopeePreview;
    try {
      preview = await c.req.json<ShopeePreview>();
    } catch {
      return c.text("Invalid preview", 400);
    }
    if (!Array.isArray(preview.rows) || preview.rows.length > 100 || !Array.isArray(preview.reportMonths) || !Array.isArray(preview.dailyPayoutRows)) {
      return c.text("Invalid preview", 400);
    }
    await c.env.UPLOADS.put(key, JSON.stringify({ preview }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: metadata,
    });
    return c.json({ ok: true });
  })
  .post("/cleanup/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.query("token") ?? "";
    if (!validPart(requestId) || !validPart(token) || !c.env.UPLOADS) return c.text("Not found", 404);
    await c.env.UPLOADS.delete(keyFor(requestId, token));
    return c.json({ ok: true });
  });
