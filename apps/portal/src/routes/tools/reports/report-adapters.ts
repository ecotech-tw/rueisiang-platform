import { momoReportParser, type ReportParser } from "./report-adapter.js";

export interface ReportSourceAdapter {
  readonly sourceType: string;
  readonly inputMode: "website" | "upload";
  readonly acceptedExtensions: readonly string[];
  readonly parser: ReportParser | null;
}

/**
 * 來源 adapter 只描述資料取得入口與 parser；匯入、SKU 對應與執行紀錄共用後端流程。
 * 網站登入仍由既有 GitHub runner 負責，避免把外部帳密或瀏覽器工作放進 Worker。
 */
export const REPORT_SOURCE_ADAPTERS: readonly ReportSourceAdapter[] = [
  { sourceType: "cyberbiz", inputMode: "website", acceptedExtensions: [], parser: null },
  { sourceType: "shopee", inputMode: "upload", acceptedExtensions: [".xlsx"], parser: null },
  { sourceType: "momo", inputMode: "upload", acceptedExtensions: [".xls", ".xlsx"], parser: momoReportParser },
];

export function reportSourceAdapter(sourceType: string): ReportSourceAdapter | undefined {
  return REPORT_SOURCE_ADAPTERS.find((adapter) => adapter.sourceType === sourceType);
}
