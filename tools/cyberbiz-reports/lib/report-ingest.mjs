function baseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("平台 URL 必須是 http/https。 ");
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

/** 將 parser 的日資料送入平台 D1；原始 XLSX 仍由 driver 上傳 Google Drive。 */
export async function ingestCyberbizReport({
  apiUrl,
  ingestToken,
  kind,
  scopeId,
  scopeName,
  rows,
  fetcher = fetch,
}) {
  if (!ingestToken) throw new Error("缺少 CYBERBIZ_REPORT_INGEST_TOKEN。 ");
  const response = await fetcher(`${baseUrl(apiUrl)}/api/internal/cyberbiz-reports/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cyberbiz-report-token": ingestToken,
    },
    body: JSON.stringify({ kind, scopeType: "store", scopeId, scopeName, rows }),
  });
  const payload = await responseJson(response, `匯入 CYBERBIZ ${kind} 日資料`);
  if (!payload.result?.scopeId) throw new Error("平台沒有回傳有效的報表匯入結果。 ");
  return payload.result;
}
