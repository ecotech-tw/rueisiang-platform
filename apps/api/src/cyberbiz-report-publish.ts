import {
  isNasStorageKey,
  type NasStorageClient,
} from "./nas-storage.js";
import {
  normalizeCyberbizMonth,
  recordCyberbizReportManifest,
  type Database,
} from "@rueisiang/db";
import type {
  CyberbizReportManifest,
  CyberbizReportScopeType,
  CyberbizReportStatus,
} from "@rueisiang/db/schema";

const REPORT_OBJECT_KEY = /^reports\/cyberbiz\/([A-Za-z0-9._-]{1,100})\/(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(json|xlsx)$/i;
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface CyberbizReportPublishInput {
  reportMonth: string;
  scopeType: CyberbizReportScopeType;
  scopeId: string;
  scopeName: string;
  coverageStart: string;
  coverageEnd: string;
  salesGranularity: "month";
  payoutGranularity: "day";
  salesSourceObjectKey?: string | null;
  payoutSourceObjectKey?: string | null;
  salesObjectKey?: string | null;
  payoutObjectKey?: string | null;
  combinedWorkbookObjectKey?: string | null;
  driveFileId?: string | null;
  driveUrl?: string | null;
  storeIdsJson: string;
  sourceChecksum: string;
  parserVersion: string;
  status: CyberbizReportStatus;
}

export class CyberbizReportPublishError extends Error {
  constructor(
    readonly status: 422 | 503,
    readonly code: "invalid_manifest" | "nas_unavailable" | "nas_object_missing" | "nas_object_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CyberbizReportPublishError";
  }
}

function monthEnd(reportMonth: string): string {
  const [year = 0, month = 0] = reportMonth.split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${reportMonth}-${String(day).padStart(2, "0")}`;
}

function objectKeyKind(
  key: string,
  input: CyberbizReportPublishInput,
): "json" | "xlsx" {
  if (!isNasStorageKey(key)) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "CYBERBIZ report object key 格式不正確。");
  }
  const match = REPORT_OBJECT_KEY.exec(key);
  if (!match || match[1] !== input.scopeId || `${match[2]}-${match[3]}` !== input.reportMonth) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "CYBERBIZ report object key 與 scope 或 period 不一致。");
  }
  return match[5]?.toLowerCase() === "json" ? "json" : "xlsx";
}

function validateInput(input: CyberbizReportPublishInput): void {
  let reportMonth: string;
  try {
    reportMonth = normalizeCyberbizMonth(input.reportMonth);
  } catch {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "reportMonth 必須是 YYYY-MM。");
  }
  if (input.scopeType !== "store" && input.scopeType !== "company") {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "scopeType 必須是 store 或 company。");
  }
  if (input.status !== "staged" && input.status !== "published") {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "publish endpoint 只接受 staged 或 published。");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.scopeId)) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "scopeId 格式不正確。");
  }
  if (input.scopeType === "company" && input.scopeId !== "company") {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "company scope 的 scopeId 必須是 company。");
  }
  if (input.scopeType === "store" && input.scopeId === "company") {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "store scope 不能使用 company scopeId。");
  }
  if (input.reportMonth !== reportMonth || input.coverageStart !== `${reportMonth}-01` || input.coverageEnd !== monthEnd(reportMonth)) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "目前只接受完整月份的 coverage。");
  }
  if (input.salesGranularity !== "month" || input.payoutGranularity !== "day") {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "salesGranularity 或 payoutGranularity 不支援。");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.sourceChecksum)) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "sourceChecksum 必須是 SHA-256 hex。");
  }
  if (!input.parserVersion.trim()) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "parserVersion 不可為空白。");
  }
  try {
    const storeIds = JSON.parse(input.storeIdsJson) as unknown;
    if (!Array.isArray(storeIds) || storeIds.some((value) => typeof value !== "string")) throw new Error();
  } catch {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "storeIdsJson 必須是字串陣列。");
  }

  const keys: Array<[string, string | null | undefined, "json" | "xlsx"]> = [
    ["salesSourceObjectKey", input.salesSourceObjectKey, "xlsx"],
    ["payoutSourceObjectKey", input.payoutSourceObjectKey, "xlsx"],
    ["salesObjectKey", input.salesObjectKey, "json"],
    ["payoutObjectKey", input.payoutObjectKey, "json"],
    ["combinedWorkbookObjectKey", input.combinedWorkbookObjectKey, "xlsx"],
  ];
  for (const [name, key, expectedKind] of keys) {
    if (!key) continue;
    if (objectKeyKind(key, input) !== expectedKind) {
      throw new CyberbizReportPublishError(422, "invalid_manifest", `${name} 的副檔名不正確。`);
    }
  }
  if (!input.salesObjectKey && !input.payoutObjectKey) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "至少要有一份 normalized sales 或 payout JSON。");
  }
  if (input.status === "published" && (!input.salesObjectKey || !input.payoutObjectKey || !input.combinedWorkbookObjectKey || !input.driveFileId || !input.driveUrl)) {
    throw new CyberbizReportPublishError(422, "invalid_manifest", "published manifest 必須同時具備 sales、payout、combined XLSX 與 Drive 資訊。");
  }
}

export function createCyberbizReportPublisher(
  db: Database,
  nas: NasStorageClient | undefined,
) {
  return {
    async publish(input: CyberbizReportPublishInput): Promise<CyberbizReportManifest> {
      validateInput(input);
      if (!nas) {
        throw new CyberbizReportPublishError(503, "nas_unavailable", "NAS storage 尚未設定，不能 publish CYBERBIZ report。");
      }

      const objects: Array<[string, string, string]> = [
        ["salesSourceObjectKey", input.salesSourceObjectKey ?? "", XLSX_CONTENT_TYPE],
        ["payoutSourceObjectKey", input.payoutSourceObjectKey ?? "", XLSX_CONTENT_TYPE],
        ["salesObjectKey", input.salesObjectKey ?? "", "application/json"],
        ["payoutObjectKey", input.payoutObjectKey ?? "", "application/json"],
        ["combinedWorkbookObjectKey", input.combinedWorkbookObjectKey ?? "", XLSX_CONTENT_TYPE],
      ];
      for (const [name, key, expectedContentType] of objects) {
        if (!key) continue;
        const object = await nas.head(key);
        if (!object) {
          throw new CyberbizReportPublishError(422, "nas_object_missing", `${name} 尚未出現在 NAS：${key}`);
        }
        if (object.contentType !== expectedContentType) {
          throw new CyberbizReportPublishError(422, "nas_object_mismatch", `${name} 的 content type 不正確。`);
        }
      }

      return recordCyberbizReportManifest(db, {
        ...input,
        salesSourceObjectKey: input.salesSourceObjectKey ?? null,
        payoutSourceObjectKey: input.payoutSourceObjectKey ?? null,
        salesObjectKey: input.salesObjectKey ?? null,
        payoutObjectKey: input.payoutObjectKey ?? null,
        combinedWorkbookObjectKey: input.combinedWorkbookObjectKey ?? null,
        driveFileId: input.driveFileId ?? null,
        driveUrl: input.driveUrl ?? null,
      });
    },
  };
}
