import { readNamedSheets } from "../payout/parser.mjs";

/**
 * 官網對帳表（管理中心 → 對帳中心）。
 *
 * 跟出金表與商品銷售報表不同的三件事：
 *
 * 1. **不是每家店一份，而是整個帳戶一份。** 出金表在後台是每家 POS 門市各一頁，
 *    對帳表只有一份，內容是官網這個通路的收款與撥款。
 * 2. **區間是半個月，不能自己選。** 系統每半個月自己產一份（1–15、16–月底），
 *    所以一個月會有兩份檔案，平台那一側必須能把兩份加起來。
 * 3. **一份檔案四張工作表**，而且費用只能從「對帳總表」或「訂單明細」拿——
 *    「依商品拆分」那張把手續費攤到每一列，加總會超出實際值（實測 1,485.24
 *    對 1,247.83）。這裡只從拆分表拿數量與金額。
 */

const SUMMARY_SHEET = "對帳總表";
const ORDER_SHEET = "訂單明細";
const ITEM_SHEET = "訂單明細（依商品拆分）";

/** 對帳總表左欄的標籤 → 我們要的欄位名。 */
const SUMMARY_FIELDS = new Map([
  ["本期代收金額", "collectedAmount"],
  ["本期退款金額", "refundAmount"],
  ["本期商家自行收款淨額", "merchantCollectedAmount"],
  ["金流手續費", "paymentFee"],
  ["系統維護費", "systemFee"],
  ["人工退款手續費", "manualRefundFee"],
  ["本期使用Cyber幣", "cyberCoinFee"],
  ["本期費用淨額", "feeAmount"],
  ["本期撥款金額", "settlementAmount"],
]);

/** 訂單明細的表頭 → 欄位名。缺任何一個就不要猜，直接失敗。 */
const ORDER_HEADERS = new Map([
  ["訂單編號", "orderNumber"],
  ["入帳時間", "accountedAt"],
  ["交易金額", "transactionAmount"],
  ["金流手續費", "paymentFee"],
  ["系統維護費", "systemFee"],
  ["人工退款手續費", "manualRefundFee"],
]);

const ITEM_HEADERS = new Map([
  ["訂單編號", "orderNumber"],
  ["商品名稱", "productName"],
  ["款式", "variantName"],
  ["商品編號(SKU)", "sku"],
  ["商品類別", "category"],
  ["數量", "quantity"],
  ["商品總額", "grossAmount"],
  ["負項", "discountAmount"],
  ["交易金額", "salesAmount"],
  ["收款方", "collectedBy"],
  ["交易型態", "transactionKind"],
]);

function text(value) {
  return value == null ? "" : String(value).trim();
}

function number(value, label) {
  if (value == null || text(value) === "") return 0;
  const parsed = Number(text(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效數字：${text(value)}`);
  return parsed;
}

/** 金額比對一律用「分」，不然 0.1 + 0.2 這種浮點誤差會讓對帳假性失敗。 */
function cents(value) {
  return Math.round(value * 100);
}

/** A1 形如「對帳區間：2026/08/16 ~ 2026/08/31」。 */
function parsePeriod(value) {
  const match = /(\d{4})\/(\d{2})\/(\d{2})\s*~\s*(\d{4})\/(\d{2})\/(\d{2})/.exec(text(value));
  if (!match) throw new Error(`找不到對帳區間：${text(value) || "空白"}`);
  const start = `${match[1]}-${match[2]}-${match[3]}`;
  const end = `${match[4]}-${match[5]}-${match[6]}`;
  if (end < start) throw new Error(`對帳區間的迄日早於起日：${start} ~ ${end}`);
  if (start.slice(0, 7) !== end.slice(0, 7)) {
    // 半月檔一定落在同一個月；跨月表示 CYBERBIZ 改了出表規則，
    // 而月加總是按 report_month 存的，猜錯會把兩個月混在一起。
    throw new Error(`對帳區間跨月，需要重新確認匯入規則：${start} ~ ${end}`);
  }
  return { start, end, reportMonth: start.slice(0, 7) };
}

function parseSummary({ cells, maxRow }) {
  const found = new Map();
  for (let row = 1; row <= maxRow; row += 1) {
    const field = SUMMARY_FIELDS.get(text(cells.get(`B${row}`)));
    if (!field || found.has(field)) continue;
    found.set(field, number(cells.get(`C${row}`), `對帳總表第 ${row} 列`));
  }
  const missing = [...SUMMARY_FIELDS].filter(([, field]) => !found.has(field)).map(([label]) => label);
  if (missing.length) throw new Error(`對帳總表缺少欄位：${missing.join("、")}`);
  return Object.fromEntries(found);
}

function columnsForHeaders({ cells, maxRow }, headers) {
  for (let row = 1; row <= Math.min(maxRow, 10); row += 1) {
    const columns = new Map();
    for (let index = 0; index < 40; index += 1) {
      const ref = index < 26
        ? String.fromCharCode(65 + index)
        : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
      const field = headers.get(text(cells.get(`${ref}${row}`)));
      if (field) columns.set(field, ref);
    }
    if (columns.size === headers.size) return { headerRow: row, columns };
  }
  return null;
}

function itemColumns(sheet) {
  const result = columnsForHeaders(sheet, ITEM_HEADERS);
  if (!result) throw new Error("依商品拆分找不到完整的表頭列。");
  return result;
}

function orderColumns(sheet) {
  const result = columnsForHeaders(sheet, ORDER_HEADERS);
  if (!result) throw new Error("訂單明細找不到完整的表頭列。");
  return result;
}

/**
 * 依商品拆分 → 每個 SKU 一列。
 *
 * 以 SKU 聚合而不是逐列送出：同一個 SKU 在一期內會出現在多張訂單，平台那一側的
 * 主鍵是 (scope, 期間, item)，不先合併會撞主鍵。
 */
/**
 * 沒有 SKU 的收費列（實測只有「運費」）也要有一個穩定的外部 SKU。
 *
 * 那些列的金額算在代收金額裡，是顧客真的付掉的錢。不給它 SKU 就進不了商品銷售，
 * 於是「Σ 商品銷售」會比營業額少一截（實測 69,900 對 71,040），而少的那 1,140
 * 不會出現在任何地方，沒有人看得出來帳少了。
 *
 * 前綴刻意跟商品的 SKU 分開，之後在 SKU 對應頁一眼看得出這不是商品。
 */
function chargeSku(productName) {
  return `CYBERBIZ-CHARGE-${productName.replace(/\s+/g, "")}`;
}

function parseItems(sheet, { collectedAmount, refundAmount, merchantCollectedAmount }) {
  const { headerRow, columns } = itemColumns(sheet);
  const { cells, maxRow } = sheet;
  const at = (field, row) => cells.get(`${columns.get(field)}${row}`);

  const bySku = new Map();
  let salesTotal = 0;
  const charges = new Map();

  for (let row = headerRow + 1; row <= maxRow; row += 1) {
    const rawSku = text(at("sku", row));
    const productName = text(at("productName", row));
    if (!rawSku && !productName) continue;

    const quantity = Math.round(number(at("quantity", row), `第 ${row} 列數量`));
    const salesAmount = number(at("salesAmount", row), `第 ${row} 列交易金額`);
    salesTotal += salesAmount;

    // 沒有 SKU 的收費列補一個穩定的外部 SKU，理由見 chargeSku。
    const sku = rawSku || chargeSku(productName);
    if (!rawSku) charges.set(sku, (charges.get(sku) ?? 0) + salesAmount);

    const variantName = text(at("variantName", row));
    const previous = bySku.get(sku) ?? {
      sku,
      productNames: new Set(),
      category: "",
      quantity: 0,
      grossAmount: 0,
      discountAmount: 0,
      salesAmount: 0,
    };
    if (productName) previous.productNames.add(variantName ? `${productName}（${variantName}）` : productName);
    const category = text(at("category", row));
    if (category) previous.category = category;
    previous.quantity += quantity;
    previous.grossAmount += number(at("grossAmount", row), `第 ${row} 列商品總額`);
    previous.discountAmount += number(at("discountAmount", row), `第 ${row} 列負項`);
    previous.salesAmount += salesAmount;
    bySku.set(sku, previous);
  }

  /*
   * 這是整份解析唯一的真正驗算：拆分表的交易金額總和必須對得上對帳總表。
   * 對不上就是欄位認錯或漏列，那種錯誤如果放過去，報表會少一筆而且沒有人會發現。
   *
   * 要對的是「收款淨額」，不是代收金額：
   *
   *   - **代收金額未扣退款，拆分表已扣。** 退款在拆分表裡是一列 `交易型態=退款`
   *     的負數（實測 2026-08-01~15 有一列 −2,400，數量 −20），而對帳總表的
   *     `本期退款金額` 也是負的，所以相加就是拆分表的總和。
   *   - **代收金額不含商家自行收款**（貨到付款那種，錢沒經過 CYBERBIZ）。拆分表
   *     有沒有把那些訂單列進來，手上的檔案還答不了——實測過的兩期自行收款都是 0。
   *     所以兩個答案都收，但不猜：等於「含自行收款」就成立；等於「不含」而自行
   *     收款不是 0，代表那些訂單沒進拆分表，Σ商品 會比營業額少一截——不知道怎麼
   *     算就整份拒收，讓人把檔案拿出來看，不要靜靜地少算錢。
   */
  const netCollected = collectedAmount + refundAmount;
  const withMerchant = netCollected + merchantCollectedAmount;
  if (cents(salesTotal) !== cents(netCollected) && cents(salesTotal) !== cents(withMerchant)) {
    throw new Error(
      `依商品拆分的交易金額總和 ${salesTotal} 對不上對帳總表：代收 ${collectedAmount} + 退款 ${refundAmount} = ${netCollected}`
      + `${merchantCollectedAmount ? `，再加上商家自行收款 ${merchantCollectedAmount} 是 ${withMerchant}` : ""}。`,
    );
  }
  if (merchantCollectedAmount && cents(salesTotal) === cents(netCollected)) {
    throw new Error(
      `這一期有商家自行收款 ${merchantCollectedAmount} 元，但依商品拆分的總和 ${salesTotal} 只等於收款淨額 ${netCollected}，`
      + "表示那些訂單沒有出現在拆分表裡，商品銷售會比營業額少這一截。請把這份檔案交給開發者確認要怎麼計入。",
    );
  }

  const items = [...bySku.values()].map(({ productNames, ...item }) => ({
    ...item,
    productName: [...productNames].join(" / ") || item.sku,
    category: item.category || "未分類",
    quantity: item.quantity,
    salesAmount: Math.round(item.salesAmount),
  }));
  items.sort((left, right) => left.sku.localeCompare(right.sku));

  // Σ items 一定等於拆分表的總和——上面的驗算已經保證了，這裡再擋一次是為了
  // 「補 SKU」那段邏輯將來被改壞時能當場發現，而不是等報表少錢。
  const itemTotal = items.reduce((sum, item) => sum + item.salesAmount, 0);
  if (cents(itemTotal) !== cents(salesTotal)) {
    throw new Error(`彙總後的商品金額 ${itemTotal} 與依商品拆分的總和 ${salesTotal} 不一致。`);
  }

  return {
    items,
    /** 補過 SKU 的收費列；第一次匯入要在 SKU 對應頁把它們對到自訂品項。 */
    charges: [...charges].map(([sku, salesAmount]) => ({ sku, salesAmount: Math.round(salesAmount) })),
    salesTotal,
  };
}

function parseAccountedDate(value, period) {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(text(value));
  if (!match) throw new Error(`訂單明細的入帳時間不是有效日期：${text(value) || "空白"}`);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (date < period.start || date > period.end) {
    throw new Error(`訂單明細的入帳日期不在對帳區間：${date}（${period.start} ~ ${period.end}）`);
  }
  return date;
}

/**
 * 依「訂單明細」的入帳時間整理每日淨入帳。
 *
 * 這不是把半月撥款假裝平均分配，而是用 CYBERBIZ 提供的每日入帳交易與逐筆費用
 * 還原每日可分配金額；半月層級的 Cyber 幣費用放在期末，最後用報表撥款金額校正
 * 每日整數化產生的零頭。真正的銀行撥款仍然只有半月一期。
 */
function parseDailyPayouts(sheet, period, summary) {
  const { headerRow, columns } = orderColumns(sheet);
  const { cells, maxRow } = sheet;
  const daily = new Map();
  let transactionTotal = 0;
  let feeTotal = 0;
  const at = (field, row) => cells.get(`${columns.get(field)}${row}`);

  for (let row = headerRow + 1; row <= maxRow; row += 1) {
    if (!text(at("orderNumber", row))) continue;
    const date = parseAccountedDate(at("accountedAt", row), period);
    const transactionAmount = number(at("transactionAmount", row), `訂單明細第 ${row} 列交易金額`);
    const fees = ["paymentFee", "systemFee", "manualRefundFee"]
      .reduce((total, field) => total + number(at(field, row), `訂單明細第 ${row} 列${field}`), 0);
    transactionTotal += transactionAmount;
    feeTotal += fees;
    daily.set(date, (daily.get(date) ?? 0) + transactionAmount - fees);
  }

  const expectedTransactions = summary.collectedAmount + summary.refundAmount + summary.merchantCollectedAmount;
  if (Math.abs(transactionTotal - expectedTransactions) > 0.5) {
    throw new Error(`訂單明細交易金額 ${transactionTotal} 對不上對帳總表收款淨額 ${expectedTransactions}。`);
  }
  const expectedBeforeCyberCoin = transactionTotal - feeTotal - summary.cyberCoinFee;
  if (Math.abs(expectedBeforeCyberCoin - summary.settlementAmount) > 0.5) {
    throw new Error(`訂單明細每日入帳淨額 ${expectedBeforeCyberCoin} 對不上半月撥款 ${summary.settlementAmount}。`);
  }

  daily.set(period.end, (daily.get(period.end) ?? 0) - summary.cyberCoinFee);
  const rows = [...daily].map(([businessDate, payoutAmount]) => ({ businessDate, payoutAmount: Math.round(payoutAmount) }));
  const roundedTotal = rows.reduce((total, row) => total + row.payoutAmount, 0);
  const adjustment = Math.round(summary.settlementAmount) - roundedTotal;
  const endRow = rows.find((row) => row.businessDate === period.end);
  if (endRow) endRow.payoutAmount += adjustment;
  else if (adjustment) rows.push({ businessDate: period.end, payoutAmount: adjustment });
  return rows.filter((row) => row.payoutAmount !== 0).sort((left, right) => left.businessDate.localeCompare(right.businessDate));
}

export async function parseShopReport(filePath) {
  const sheets = await readNamedSheets(filePath, [SUMMARY_SHEET, ORDER_SHEET, ITEM_SHEET]);
  const summarySheet = sheets.get(SUMMARY_SHEET);
  const orderSheet = sheets.get(ORDER_SHEET);
  const itemSheet = sheets.get(ITEM_SHEET);

  const period = parsePeriod(summarySheet.cells.get("A1"));
  const itemPeriod = parsePeriod(itemSheet.cells.get("A1"));
  if (itemPeriod.start !== period.start || itemPeriod.end !== period.end) {
    throw new Error("兩張工作表的對帳區間不一致，檔案可能被手動編輯過。");
  }

  const summary = parseSummary(summarySheet);
  const { items, charges, salesTotal } = parseItems(itemSheet, summary);

  // 撥款 = 收款淨額 − 費用淨額。退款在檔案裡是負數，所以這裡是相加。
  const netCollected = summary.collectedAmount + summary.refundAmount + summary.merchantCollectedAmount;
  const expected = netCollected - summary.feeAmount;
  if (cents(expected) !== cents(summary.settlementAmount)) {
    throw new Error(
      `撥款金額對不上：代收 ${summary.collectedAmount} + 退款 ${summary.refundAmount} + 自行收款 ${summary.merchantCollectedAmount} − 費用 ${summary.feeAmount} = ${expected}，但檔案寫 ${summary.settlementAmount}。`,
    );
  }
  const dailyPayouts = parseDailyPayouts(orderSheet, period, summary);

  return {
    period,
    summary,
    /*
     * 營業額用拆分表的總和，不用「代收 + 自行收款」。
     *
     * 兩個數字在通過上面的驗算之後一定相等，但**來源不同**：拆分表是 items 的
     * 來源，所以用它才保證「Σ 商品銷售 = 營業額」是恆等式而不是巧合。寫成
     * 另一個來源的話，將來哪一邊漂掉都要等報表對不上才會發現。
     */
    revenueAmount: Math.round(salesTotal),
    /** 半月對帳單載明的撥款總額；逐日可分配列在 dailyPayouts。 */
    settlementAmount: Math.round(summary.settlementAmount),
    dailyPayouts,
    items,
    charges,
  };
}
