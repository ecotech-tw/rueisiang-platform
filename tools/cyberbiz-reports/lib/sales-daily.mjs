export function eachDay(start, end) {
  const days = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({ label: day, start: day, end: day });
  }
  return days;
}

/**
 * 單日失敗不應該丟掉同一批已成功解析的日資料，讓 runner 能先匯入可用部分並標記待補日期。
 *
 * coveredDates 只收「成功讀到報表」的日子，包含當天零筆的情況——匯入端要靠它才能把
 * 「當天真的沒賣東西」跟「當天匯出失敗」分開：前者要清掉舊資料，後者必須原封不動。
 * 只看 rows 的話零筆的日子會消失，等於被當成失敗日而永久保留過期的 SKU。
 */
export async function collectSalesDailyRows({ range, localPath, loadDay }) {
  const dailyRows = [];
  const failures = [];
  const coveredDates = [];
  for (const day of eachDay(range.start, range.end)) {
    try {
      const daily = await loadDay(day, day.start === range.start && day.end === range.end ? localPath : null);
      coveredDates.push(day.start);
      for (const row of daily.rows) dailyRows.push({
        businessDate: day.start,
        sku: row.sku,
        productName: row.productName,
        category: row.category,
        grossQuantity: Math.round(row.grossQuantity),
        returnQuantity: Math.round(row.returnQuantity),
        netQuantity: Math.round(row.netQuantity),
        salesAmount: Math.round(row.salesAmount),
      });
    } catch (error) {
      failures.push({ day, error });
    }
  }
  return { rows: dailyRows, failures, coveredDates };
}
