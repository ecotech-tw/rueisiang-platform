export function eachDay(start, end) {
  const days = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({ label: day, start: day, end: day });
  }
  return days;
}

/** 單日失敗不應該丟掉同一批已成功解析的日資料，讓 runner 能先匯入可用部分並標記待補日期。 */
export async function collectSalesDailyRows({ range, localPath, loadDay }) {
  const dailyRows = [];
  const failures = [];
  for (const day of eachDay(range.start, range.end)) {
    try {
      const daily = await loadDay(day, day.start === range.start && day.end === range.end ? localPath : null);
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
  return { rows: dailyRows, failures };
}
