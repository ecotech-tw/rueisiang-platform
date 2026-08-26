import {
  aggregateCyberbizPayout,
  aggregateCyberbizSales,
  findCyberbizReportManifest,
  isCyberbizPayoutDocument,
  isCyberbizSalesDocument,
  normalizeCyberbizMonth,
  type CyberbizPayoutDocument,
  type CyberbizPayoutQuery,
  type CyberbizPayoutQueryResult,
  type CyberbizSalesDocument,
  type CyberbizSalesQuery,
  type CyberbizSalesQueryResult,
  type Database,
} from "@rueisiang/db";
import type { NasStorageClient } from "./nas-storage.js";

export class CyberbizReportQueryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CyberbizReportQueryError";
    this.status = status;
    this.code = code;
  }
}

function monthRange(reportMonth: string): { start: string; end: string } {
  const [year = 0, month = 0] = reportMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${reportMonth}-01`, end: `${reportMonth}-${String(lastDay).padStart(2, "0")}` };
}

function noData(reportMonth: string): CyberbizSalesQueryResult {
  const range = monthRange(reportMonth);
  return {
    status: "NO_DATA_FOR_RANGE",
    reportMonth,
    requestedStart: range.start,
    requestedEnd: range.end,
    message: "指定月份沒有已發布的 CYBERBIZ 銷售資料。",
  };
}

function unsupportedRange(reportMonth: string, startDate: string, endDate: string): CyberbizSalesQueryResult {
  return {
    status: "UNSUPPORTED_GRANULARITY",
    reportMonth,
    requestedStart: startDate,
    requestedEnd: endDate,
    message: "商品銷售總表只有月彙總；目前不能從月報精確拆出日或任意日期區間。",
  };
}

async function readSalesDocument(nas: NasStorageClient, key: string): Promise<CyberbizSalesDocument | null> {
  const response = await nas.get(key);
  if (!response) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new CyberbizReportQueryError(502, "invalid_report_json", "NAS 上的 CYBERBIZ normalized JSON 無法解析。");
  }
  if (!isCyberbizSalesDocument(payload)) {
    throw new CyberbizReportQueryError(502, "invalid_report_document", "NAS 上的 CYBERBIZ normalized JSON 格式不符合目前版本。");
  }
  return payload;
}

async function readPayoutDocument(nas: NasStorageClient, key: string): Promise<CyberbizPayoutDocument | null> {
  const response = await nas.get(key);
  if (!response) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new CyberbizReportQueryError(502, "invalid_report_json", "NAS 上的 CYBERBIZ payout normalized JSON 無法解析。");
  }
  if (!isCyberbizPayoutDocument(payload)) {
    throw new CyberbizReportQueryError(502, "invalid_payout_document", "NAS 上的 CYBERBIZ payout normalized JSON 格式不符合目前版本。");
  }
  return payload;
}

export function createCyberbizReportService(db: Database, nas: NasStorageClient | undefined) {
  return {
    async querySales(input: CyberbizSalesQuery): Promise<CyberbizSalesQueryResult> {
      const reportMonth = normalizeCyberbizMonth(input.reportMonth);
      const fullRange = monthRange(reportMonth);
      const startDate = input.startDate ?? fullRange.start;
      const endDate = input.endDate ?? fullRange.end;
      if (startDate !== fullRange.start || endDate !== fullRange.end) {
        return unsupportedRange(reportMonth, startDate, endDate);
      }
      if (!nas) throw new CyberbizReportQueryError(503, "nas_not_configured", "NAS storage 尚未設定，暫時無法查詢 CYBERBIZ 報表。");

      const scopeId = input.scopeType === "company" ? "company" : input.scopeId;
      if (!scopeId) throw new CyberbizReportQueryError(400, "missing_scope_id", "查詢單一櫃位時需要 scopeId。");
      const manifest = await findCyberbizReportManifest(db, {
        reportMonth,
        scopeType: input.scopeType,
        scopeId,
      });
      if (!manifest?.salesObjectKey) return noData(reportMonth);

      const document = await readSalesDocument(nas, manifest.salesObjectKey);
      if (!document) return noData(reportMonth);
      if (document.reportMonth !== reportMonth || document.scopeType !== input.scopeType || document.scopeId !== scopeId) {
        throw new CyberbizReportQueryError(502, "report_manifest_mismatch", "CYBERBIZ manifest 與 normalized JSON 的月份或 scope 不一致。");
      }
      return aggregateCyberbizSales([document], { ...input, reportMonth, scopeId }, manifest);
    },
    async queryPayout(input: CyberbizPayoutQuery): Promise<CyberbizPayoutQueryResult> {
      const reportMonth = normalizeCyberbizMonth(input.reportMonth);
      const fullRange = monthRange(reportMonth);
      const startDate = input.startDate || fullRange.start;
      const endDate = input.endDate || fullRange.end;
      if (!nas) throw new CyberbizReportQueryError(503, "nas_not_configured", "NAS storage 尚未設定，暫時無法查詢 CYBERBIZ 報表。");

      const scopeId = input.scopeType === "company" ? "company" : input.scopeId;
      if (!scopeId) throw new CyberbizReportQueryError(400, "missing_scope_id", "查詢單一櫃位時需要 scopeId。");
      const manifest = await findCyberbizReportManifest(db, {
        reportMonth,
        scopeType: input.scopeType,
        scopeId,
      });
      if (!manifest?.payoutObjectKey) {
        return aggregateCyberbizPayout([], { ...input, reportMonth, startDate, endDate });
      }
      const document = await readPayoutDocument(nas, manifest.payoutObjectKey);
      if (!document) return aggregateCyberbizPayout([], { ...input, reportMonth, startDate, endDate });
      if (document.reportMonth !== reportMonth || document.scopeType !== input.scopeType || document.scopeId !== scopeId) {
        throw new CyberbizReportQueryError(502, "report_manifest_mismatch", "CYBERBIZ manifest 與 payout normalized JSON 的月份或 scope 不一致。");
      }
      return aggregateCyberbizPayout([document], { ...input, reportMonth, startDate, endDate, scopeId }, manifest);
    },
  };
}
