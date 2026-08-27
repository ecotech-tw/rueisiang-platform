function baseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("平台 URL 必須是 http/https。 ");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function payoutIngestRows(rows) {
  return rows.map((row) => ({ businessDate: row.date, payoutAmount: Math.round(row.incomeAmount) }));
}

export function monthlySalesIngestRows(rows, reportMonth) {
  const result = new Map();
  for (const row of rows) {
    const rowMonth = String(row.reportMonth || row.businessDate || "").slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rowMonth)) throw new Error("商品銷售資料缺少有效的 reportMonth。 ");
    if (reportMonth && rowMonth !== reportMonth) throw new Error("商品銷售資料的月份不一致。 ");
    const sku = String(row.sku ?? "").trim();
    if (!sku) throw new Error("商品銷售資料缺少 SKU。 ");
    const key = `${rowMonth}\u0000${sku}`;
    const previous = result.get(key) ?? {
      reportMonth: rowMonth,
      sku,
      productNames: new Set(),
      category: "未分類",
      grossQuantity: 0,
      returnQuantity: 0,
      netQuantity: 0,
      salesAmount: 0,
    };
    const productName = String(row.productName ?? "").trim();
    if (productName) previous.productNames.add(productName);
    if (row.category) previous.category = String(row.category).trim();
    previous.grossQuantity += Math.round(Number(row.grossQuantity ?? 0));
    previous.returnQuantity += Math.round(Number(row.returnQuantity ?? 0));
    previous.netQuantity += Math.round(Number(row.netQuantity ?? 0));
    previous.salesAmount += Math.round(Number(row.salesAmount ?? 0));
    result.set(key, previous);
  }
  return [...result.values()].map(({ productNames, ...row }) => ({
    ...row,
    productName: [...productNames].join(" / "),
  }));
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

/** 將 parser 的報表資料送入平台 D1；原始 XLSX 仍由 driver 上傳 Google Drive。 */
export async function ingestReport({
  apiUrl,
  ingestToken,
  scopeId,
  scopeName,
  kind,
  rows,
  reportMonth,
  salesRows,
  payoutRows,
  fetcher = fetch,
}) {
  if (!ingestToken) throw new Error("缺少 CYBERBIZ_REPORT_INGEST_TOKEN。 ");
  const bundle = Array.isArray(salesRows) && Array.isArray(payoutRows);
  const response = await fetcher(`${baseUrl(apiUrl)}/api/internal/cyberbiz-reports/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cyberbiz-report-token": ingestToken,
    },
    body: JSON.stringify(bundle
      ? {
        kind: "sales_and_payout",
        scopeType: "store",
        scopeId,
        scopeName,
        salesRows,
        payoutRows,
        ...(reportMonth ? { reportMonth } : {}),
      }
      : { kind, scopeType: "store", scopeId, scopeName, rows, ...(reportMonth ? { reportMonth } : {}) }),
  });
  const payload = await responseJson(response, bundle
    ? "匯入蝦皮 sales 與 payout 月資料"
    : `匯入 CYBERBIZ ${kind === "sales" ? "月" : "日"}資料`);
  if (!payload.result?.scopeId) throw new Error("平台沒有回傳有效的報表匯入結果。 ");
  return payload.result;
}

export const ingestCyberbizReport = ingestReport;
