function assertDocument(document, kind) {
  if (!document || document.schemaVersion !== 1 || document.kind !== kind) {
    throw new Error(`不能 aggregate 非 ${kind} document。`);
  }
  if (document.scopeType !== "store") throw new Error("company aggregate 只接受 store documents。 ");
  if (!Array.isArray(document.rows) || !document.rows.length) throw new Error("aggregate 的 document 沒有明細。 ");
}

function assertSameCoverage(documents) {
  const first = documents[0];
  for (const document of documents) {
    if (document.reportMonth !== first.reportMonth || document.coverageStart !== first.coverageStart || document.coverageEnd !== first.coverageEnd) {
      throw new Error("不同櫃位的 report month 或 coverage 不一致，不能產生公司 aggregate。 ");
    }
  }
  return first;
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 在 runner 上先把各櫃位月報合成一份 company document，讓公司查詢只需一次 D1 lookup + 一次 NAS GET。
 * SKU 是跨櫃位合併鍵；商品名稱與分類若同 SKU 卻不一致，直接停下來避免產出無法解釋的 aggregate。
 */
export function aggregateSalesDocuments(documents, {
  scopeName = "公司整體",
  parserVersion = "cyberbiz-sales-company-v1",
} = {}) {
  if (!Array.isArray(documents) || !documents.length) throw new Error("至少需要一份櫃位 sales document。 ");
  for (const document of documents) assertDocument(document, "cyberbiz_sales_monthly");
  const first = assertSameCoverage(documents);
  const bySku = new Map();

  for (const document of documents) {
    for (const row of document.rows) {
      const key = String(row.sku).trim().toLowerCase();
      const existing = bySku.get(key);
      if (!existing) {
        bySku.set(key, { ...row });
        continue;
      }
      if (existing.productName !== row.productName || existing.category !== row.category) {
        throw new Error(`SKU ${row.sku} 在不同櫃位的商品名稱或分類不一致。`);
      }
      existing.grossQuantity += row.grossQuantity;
      existing.returnQuantity += row.returnQuantity;
      existing.netQuantity += row.netQuantity;
      existing.salesAmount += row.salesAmount;
      for (const field of ["costAmount", "grossProfit"]) {
        const value = optionalNumber(row[field]);
        if (value !== undefined) existing[field] = (existing[field] ?? 0) + value;
      }
      if (existing.grossProfit !== undefined && existing.salesAmount !== 0) {
        existing.grossMargin = (existing.grossProfit / existing.salesAmount) * 100;
      } else {
        delete existing.grossMargin;
      }
    }
  }

  const rows = [...bySku.values()].sort((left, right) => left.productName.localeCompare(right.productName, "zh-Hant"));
  return {
    schemaVersion: 1,
    kind: "cyberbiz_sales_monthly",
    scopeType: "company",
    scopeId: "company",
    scopeName,
    reportMonth: first.reportMonth,
    coverageStart: first.coverageStart,
    coverageEnd: first.coverageEnd,
    granularity: "month",
    rows,
    totals: rows.reduce((totals, row) => ({
      grossQuantity: totals.grossQuantity + row.grossQuantity,
      returnQuantity: totals.returnQuantity + row.returnQuantity,
      netQuantity: totals.netQuantity + row.netQuantity,
      salesAmount: totals.salesAmount + row.salesAmount,
    }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 }),
    source: { parserVersion },
  };
}

/** 出金資料沒有 SKU，公司的 aggregate 是保留每一筆日資料後再加總。 */
export function aggregatePayoutDocuments(documents, {
  scopeName = "公司整體",
  parserVersion = "cyberbiz-payout-company-v1",
} = {}) {
  if (!Array.isArray(documents) || !documents.length) throw new Error("至少需要一份櫃位 payout document。 ");
  for (const document of documents) assertDocument(document, "cyberbiz_payout_daily");
  const first = assertSameCoverage(documents);
  const rows = documents.flatMap((document) => document.rows.map((row) => ({ ...row })));
  return {
    schemaVersion: 1,
    kind: "cyberbiz_payout_daily",
    scopeType: "company",
    scopeId: "company",
    scopeName,
    reportMonth: first.reportMonth,
    coverageStart: first.coverageStart,
    coverageEnd: first.coverageEnd,
    granularity: "day",
    rows: rows.sort((left, right) => `${left.date}-${left.closeAt}`.localeCompare(`${right.date}-${right.closeAt}`)),
    totals: {
      incomeAmount: rows.reduce((total, row) => total + row.incomeAmount, 0),
      rowCount: rows.length,
    },
    source: { parserVersion },
  };
}
