import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  createCyberbizReportPublisher,
  CyberbizReportPublishError,
  type CyberbizReportPublishInput,
} from "../cyberbiz-report-publish.js";
import { nasStorageClient } from "../nas-storage.js";

const INGEST_TOKEN_HEADER = "x-cyberbiz-report-token";
const REQUIRED_STRING_FIELDS = [
  "reportMonth",
  "scopeType",
  "scopeId",
  "scopeName",
  "coverageStart",
  "coverageEnd",
  "salesGranularity",
  "payoutGranularity",
  "storeIdsJson",
  "sourceChecksum",
  "parserVersion",
  "status",
] as const;
const OPTIONAL_STRING_FIELDS = [
  "reportKind",
  "salesSourceObjectKey",
  "payoutSourceObjectKey",
  "salesObjectKey",
  "payoutObjectKey",
  "combinedWorkbookObjectKey",
  "driveFileId",
  "driveUrl",
] as const;

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
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPublishInput(value: unknown): CyberbizReportPublishInput {
  if (!isRecord(value)) throw new CyberbizReportPublishError(422, "invalid_manifest", "publish body 必須是 JSON object。");
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof value[field] !== "string") {
      throw new CyberbizReportPublishError(422, "invalid_manifest", `${field} 必須是字串。`);
    }
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") {
      throw new CyberbizReportPublishError(422, "invalid_manifest", `${field} 必須是字串或 null。`);
    }
  }
  return {
    reportMonth: value.reportMonth as string,
    reportKind: (value.reportKind as CyberbizReportPublishInput["reportKind"] | null | undefined) ?? undefined,
    scopeType: value.scopeType as CyberbizReportPublishInput["scopeType"],
    scopeId: value.scopeId as string,
    scopeName: value.scopeName as string,
    coverageStart: value.coverageStart as string,
    coverageEnd: value.coverageEnd as string,
    salesGranularity: value.salesGranularity as "month",
    payoutGranularity: value.payoutGranularity as "day",
    salesSourceObjectKey: (value.salesSourceObjectKey as string | null | undefined) ?? null,
    payoutSourceObjectKey: (value.payoutSourceObjectKey as string | null | undefined) ?? null,
    salesObjectKey: (value.salesObjectKey as string | null | undefined) ?? null,
    payoutObjectKey: (value.payoutObjectKey as string | null | undefined) ?? null,
    combinedWorkbookObjectKey: (value.combinedWorkbookObjectKey as string | null | undefined) ?? null,
    driveFileId: (value.driveFileId as string | null | undefined) ?? null,
    driveUrl: (value.driveUrl as string | null | undefined) ?? null,
    storeIdsJson: value.storeIdsJson as string,
    sourceChecksum: value.sourceChecksum as string,
    parserVersion: value.parserVersion as string,
    status: value.status as CyberbizReportPublishInput["status"],
  };
}

export const cyberbizReportsInternal = new Hono<AppEnv>()
  .post("/publish", async (c) => {
    if (!await sameSecret(c.req.header(INGEST_TOKEN_HEADER), c.env.CYBERBIZ_REPORT_INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      let body: unknown;
      try {
        body = await c.req.json<unknown>();
      } catch {
        throw new CyberbizReportPublishError(422, "invalid_manifest", "publish body 必須是有效 JSON。");
      }
      const input = readPublishInput(body);
      const publisher = createCyberbizReportPublisher(c.get("db"), nasStorageClient(c.env));
      const manifest = await publisher.publish(input);
      return c.json({ manifest }, 200);
    } catch (error) {
      if (error instanceof CyberbizReportPublishError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
  });
