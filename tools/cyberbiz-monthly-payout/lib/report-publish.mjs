import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REPORT_OBJECT_KEY = /^reports\/cyberbiz\/([A-Za-z0-9._-]{1,100})\/(\d{4})\/(0[1-9]|1[0-2])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(json|xlsx)$/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectIdFor(sourceChecksum, role) {
  const hex = sha256(`${sourceChecksum}:${role}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function baseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("NAS 或平台 URL 必須是 http/https。 ");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function responseJson(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} 失敗（HTTP ${response.status}）：${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} 回傳的 JSON 格式不正確。`);
  }
}

function reportObjectKey(value, { scopeId, reportMonth, extension }) {
  if (typeof value !== "string") throw new Error("NAS 回傳的 object key 不是字串。 ");
  const match = REPORT_OBJECT_KEY.exec(value);
  if (!match || match[1] !== scopeId || `${match[2]}-${match[3]}` !== reportMonth || match[5].toLowerCase() !== extension) {
    throw new Error("NAS 回傳的 object key 與這次 report 的 scope、period 或格式不一致。 ");
  }
  return value;
}

async function uploadObject({ nasUrl, nasToken, scopeId, reportMonth, sourceChecksum, role, bytes, contentType, fetcher }) {
  if (!nasToken) throw new Error("缺少 NAS_STORAGE_TOKEN。 ");
  const extension = contentType === "application/json" ? "json" : "xlsx";
  const url = new URL(`${baseUrl(nasUrl)}/v1/objects`);
  url.searchParams.set("namespace", "reports");
  url.searchParams.set("scope", "cyberbiz");
  url.searchParams.set("scopeId", scopeId);
  url.searchParams.set("period", reportMonth);
  url.searchParams.set("objectId", objectIdFor(sourceChecksum, role));
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-storage-token": nasToken,
    },
    body: bytes,
  });
  const payload = await responseJson(response, `上傳 ${role} 到 NAS`);
  const object = payload?.object;
  const key = reportObjectKey(object?.key, { scopeId, reportMonth, extension });
  if (!Number.isSafeInteger(object?.size) || object.size <= 0 || object.size !== bytes.byteLength) {
    throw new Error(`NAS 回傳的 ${role} size 不正確。`);
  }
  if (object.checksum !== sha256(bytes)) throw new Error(`NAS 回傳的 ${role} checksum 不正確。`);
  return { key, checksum: object.checksum, size: object.size, contentType };
}

export async function checksumReportSources(paths) {
  const hash = createHash("sha256");
  for (const [role, filePath] of paths) {
    if (!filePath) continue;
    hash.update(role);
    hash.update(await fs.readFile(filePath));
  }
  return hash.digest("hex");
}

export async function publishCyberbizManifest({ apiUrl, ingestToken, manifest, fetcher = fetch }) {
  if (!ingestToken) throw new Error("缺少 CYBERBIZ_REPORT_INGEST_TOKEN。 ");
  const response = await fetcher(`${baseUrl(apiUrl)}/api/internal/cyberbiz-reports/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cyberbiz-report-token": ingestToken,
    },
    body: JSON.stringify(manifest),
  });
  const payload = await responseJson(response, `寫入 CYBERBIZ ${manifest.status} manifest`);
  if (!payload.manifest?.id) throw new Error("平台沒有回傳有效的 CYBERBIZ manifest。 ");
  return payload.manifest;
}

/**
 * 上傳原始 XLSX、normalized JSON 與 combined workbook，先 staged；Drive 完成後再 published。
 * objectId 由來源 checksum 與欄位名稱決定，所以相同批次重跑不會在 NAS 產生重複檔案。
 */
export async function publishCyberbizReport({
  nasUrl,
  nasToken,
  apiUrl,
  ingestToken,
  reportMonth,
  scopeType = "store",
  scopeId,
  scopeName = "",
  coverageStart,
  coverageEnd,
  storeIdsJson = "[]",
  parserVersion,
  salesSourcePath,
  payoutSourcePath,
  salesJsonPath,
  payoutJsonPath,
  combinedWorkbookPath,
  sourceChecksum,
  fetcher = fetch,
  afterStaged,
}) {
  const sources = [
    ["sales-source", salesSourcePath],
    ["payout-source", payoutSourcePath],
    ["sales-json", salesJsonPath],
    ["payout-json", payoutJsonPath],
    ["combined-workbook", combinedWorkbookPath],
  ];
  const checksum = sourceChecksum ?? await checksumReportSources(sources);
  const uploads = {};
  for (const [role, filePath, contentType] of [
    ["salesSourceObjectKey", salesSourcePath, XLSX_CONTENT_TYPE],
    ["payoutSourceObjectKey", payoutSourcePath, XLSX_CONTENT_TYPE],
    ["salesObjectKey", salesJsonPath, "application/json"],
    ["payoutObjectKey", payoutJsonPath, "application/json"],
    ["combinedWorkbookObjectKey", combinedWorkbookPath, XLSX_CONTENT_TYPE],
  ]) {
    if (!filePath) continue;
    const bytes = await fs.readFile(filePath);
    uploads[role] = (await uploadObject({
      nasUrl,
      nasToken,
      scopeId,
      reportMonth,
      sourceChecksum: checksum,
      role,
      bytes,
      contentType,
      fetcher,
    })).key;
  }

  const baseManifest = {
    reportMonth,
    scopeType,
    scopeId,
    scopeName,
    coverageStart,
    coverageEnd,
    salesGranularity: "month",
    payoutGranularity: "day",
    salesSourceObjectKey: uploads.salesSourceObjectKey ?? null,
    payoutSourceObjectKey: uploads.payoutSourceObjectKey ?? null,
    salesObjectKey: uploads.salesObjectKey ?? null,
    payoutObjectKey: uploads.payoutObjectKey ?? null,
    combinedWorkbookObjectKey: uploads.combinedWorkbookObjectKey ?? null,
    driveFileId: null,
    driveUrl: null,
    storeIdsJson,
    sourceChecksum: checksum,
    parserVersion,
    status: "staged",
  };
  const staged = await publishCyberbizManifest({ apiUrl, ingestToken, manifest: baseManifest, fetcher });
  if (!afterStaged) return staged;

  const drive = await afterStaged({ staged, sourceChecksum: checksum });
  if (!drive?.driveFileId || !drive.driveUrl) return staged;
  return publishCyberbizManifest({
    apiUrl,
    ingestToken,
    manifest: { ...baseManifest, driveFileId: drive.driveFileId, driveUrl: drive.driveUrl, status: "published" },
    fetcher,
  });
}
