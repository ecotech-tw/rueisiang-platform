import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createCyberbizReportIngestor, CyberbizReportIngestError } from "../cyberbiz-report-ingest.js";
import { forgetReportAnalytics } from "../report-cache.js";
import { cacheClient } from "../upstash.js";

const INGEST_TOKEN_HEADER = "x-cyberbiz-report-token";

async function sameSecret(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export const cyberbizReportsInternal = new Hono<AppEnv>()
  .post("/ingest", async (c) => {
    if (!await sameSecret(c.req.header(INGEST_TOKEN_HEADER), c.env.CYBERBIZ_REPORT_INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      let body: unknown;
      try {
        body = await c.req.json<unknown>();
      } catch {
        throw new CyberbizReportIngestError(422, "invalid_ingest");
      }
      const result = await createCyberbizReportIngestor(c.get("db")).ingest(body);
      return c.json({ result }, 200);
    } catch (error) {
      if (error instanceof CyberbizReportIngestError) return c.json({ error: error.code, message: error.message }, error.status);
      throw error;
    } finally {
      // ingest 可能已先寫入 scope 或部分批次後才失敗；成功與失敗都要清掉報表快取。
      await forgetReportAnalytics(cacheClient(c.env));
    }
  });
