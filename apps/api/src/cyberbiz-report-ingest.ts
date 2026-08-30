import {
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  findReportScope,
  upsertReportScope,
  normalizeExternalSku,
  normalizeProductSkuChannel,
  resolveIgnoredSkus,
  resolveProductSkus,
  type Database,
  type ReportScopeKind,
} from "@rueisiang/db";

export type CyberbizReportIngestKind = "sales" | "payout" | "sales_and_payout";

export interface CyberbizReportIngestInput {
  kind: CyberbizReportIngestKind;
  scopeType: ReportScopeKind;
  scopeId: string;
  scopeName: string;
  rows?: unknown[];
  /** 商品銷售以整月快照匯入；出金仍由 rows 內的 businessDate 決定。 */
  reportMonth?: string;
  salesRows?: unknown[];
  payoutRows?: unknown[];
}

export class CyberbizReportIngestError extends Error {
  constructor(
    readonly status: 422,
    readonly code: "invalid_ingest",
    message = "CYBERBIZ 報表匯入資料格式不正確。",
  ) {
    super(message);
    this.name = "CyberbizReportIngestError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value.trim();
}

function date(value: unknown): string {
  const result = text(value);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  return result;
}

function month(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return result;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value;
}

function reportChannel(scopeId: string): string {
  const [prefix, scopePart] = scopeId.split(":", 2);
  if (!scopePart) return "legacy";
  return normalizeProductSkuChannel(prefix ?? "") || "legacy";
}

function readInput(value: unknown): CyberbizReportIngestInput {
  const isSingle = record(value) && (value.kind === "sales" || value.kind === "payout") && Array.isArray(value.rows);
  const isBundle = record(value) && value.kind === "sales_and_payout"
    && Array.isArray(value.salesRows) && Array.isArray(value.payoutRows);
  if (!record(value) || (!isSingle && !isBundle) || value.scopeType !== "store") {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if ((value.kind === "sales" || value.kind === "sales_and_payout") && value.reportMonth !== undefined) {
    month(value.reportMonth);
  }
  if ((value.kind === "sales" || value.kind === "sales_and_payout")
    && value.reportMonth === undefined
    && (value.kind === "sales_and_payout" || (value.rows as unknown[]).length === 0)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if (value.coveredDates !== undefined) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return {
    kind: value.kind as CyberbizReportIngestKind,
    scopeType: "store",
    scopeId: text(value.scopeId),
    scopeName: text(value.scopeName),
    ...(isSingle ? { rows: value.rows as unknown[] } : {}),
    ...(isBundle ? { salesRows: value.salesRows as unknown[], payoutRows: value.payoutRows as unknown[] } : {}),
    ...((value.kind === "sales" || value.kind === "sales_and_payout") && value.reportMonth !== undefined
      ? { reportMonth: month(value.reportMonth) }
      : {}),
  };
}

interface ParsedSalesRow {
  reportMonth: string;
  externalSku: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

function parseSalesRows(input: CyberbizReportIngestInput): ParsedSalesRow[] {
  const rows = new Map<string, {
    reportMonth: string;
    externalSku: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  }>();
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    if (value.businessDate !== undefined) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const reportMonth = month(value.reportMonth ?? input.reportMonth);
    if (input.reportMonth && reportMonth !== input.reportMonth) {
      throw new CyberbizReportIngestError(422, "invalid_ingest");
    }
    const externalSku = normalizeExternalSku(text(value.sku));
    const key = `${reportMonth}\u0000${externalSku}`;
    const previous = rows.get(key);
    rows.set(key, {
      reportMonth,
      externalSku,
      grossQuantity: (previous?.grossQuantity ?? 0) + integer(value.grossQuantity ?? 0),
      returnQuantity: (previous?.returnQuantity ?? 0) + integer(value.returnQuantity ?? 0),
      netQuantity: (previous?.netQuantity ?? 0) + integer(value.netQuantity ?? 0),
      salesAmount: (previous?.salesAmount ?? 0) + integer(value.salesAmount ?? 0),
    });
  }
  return [...rows.values()];
}

async function normalizeSalesRows(
  db: Database,
  input: CyberbizReportIngestInput,
  channel = reportChannel(input.scopeId),
  // sales_and_payout 會先 parse 一次做格式驗證，把結果傳進來，省掉整份報表重複解析與彙總。
  preparsed?: ParsedSalesRow[],
): Promise<{
  rows: Array<{
    scopeId: string;
    reportMonth: string;
    sku: string;
    productName: string;
    category: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
    updatedAt: string;
  }>;
  /** 對不到任何對應，也沒被標記忽略——要人去補的。 */
  skippedSkus: string[];
}> {
  const parsed = preparsed ?? parseSalesRows(input);
  if (!parsed.length) return { rows: [], skippedSkus: [] };

  const resolved = await resolveProductSkus(db, parsed.map((row) => row.externalSku), channel);

  /*
   * 對不到的外部 SKU 略過，其餘照常寫入。
   *
   * 以前是整份 422。實際跑下來十幾個沒建對應的 SKU 就讓九家店的整個月一筆都進不去——
   * 一個沒對應的贈品擋掉全部營收，代價完全不成比例。改成略過並回報，之後補好對應
   * 重跑即可：寫入是每個（據點, 月份）先刪再插，重跑會把那個月整個重寫。
   *
   * ignored 是刻意排除的（補寄、已下架），不需要提醒；skipped 才是要人去補的。
   */
  const ignored = await resolveIgnoredSkus(db, parsed.map((row) => row.externalSku), channel);
  const skipped: string[] = [];
  const usable: ParsedSalesRow[] = [];
  const seenSkipped = new Set<string>();
  for (const row of parsed) {
    /*
     * 忽略要排在解析之前。
     *
     * 目錄 fallback 會解析出整份 CYBERBIZ 目錄（包含已下架商品，那份鏡像刻意不刪），
     * 所以先問「解析得出來嗎」的話，補寄與已下架這兩種「標記為不納入」的 SKU 反而
     * 每一個都解析成功、照樣寫進報表——整個忽略功能等於不存在。
     */
    if (ignored.has(row.externalSku)) continue;
    if (resolved.has(row.externalSku)) {
      usable.push(row);
      continue;
    }
    if (!seenSkipped.has(row.externalSku)) {
      seenSkipped.add(row.externalSku);
      skipped.push(row.externalSku);
    }
  }

  // 先 mapping 再加總：多個通路 SKU 可能對應同一個 system SKU，不能在外部 SKU 階段結束加總。
  // 一般 WMS mapping 維持既有組合用料展開，讓庫存商品可以統計實際用量；沒有 WMS 主商品
  // 的自訂 mapping 則以 system SKU 保存一筆商品銷售，避免蝦皮 Product ID 與 CYBERBIZ SKU
  // 因為被拆成不同的第一個用料而無法合併。自訂 mapping 的組合用料仍保留在設定中。
  const rows = new Map<string, {
    scopeId: string;
    reportMonth: string;
    sku: string;
    productName: string;
    category: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
    updatedAt: string;
  }>();
  for (const row of usable) {
    const item = resolved.get(row.externalSku)!;
    /*
     * 每一筆對應都展開成用料，沒有例外。
     *
     * 銷售額整筆放在第一列用料上：拆分沒有正確答案（報表只給整筆金額），重複計算又會
     * 讓月營收灌水。用料的排序在 resolveProductSkus 是決定性的，所以重匯不會換一列收錢。
     * 名稱與分類直接取用料自己的來源（WMS 商品或自訂報表商品），兩者都只有一份，
     * 不需要再比較誰比較 canonical。
     */
    for (const [index, component] of item.components.entries()) {
      const key = `${row.reportMonth}::${component.sku}`;
      const previous = rows.get(key);
      rows.set(key, {
        scopeId: input.scopeId,
        reportMonth: row.reportMonth,
        sku: component.sku,
        productName: previous?.productName ?? component.name,
        category: previous?.category ?? component.category,
        grossQuantity: (previous?.grossQuantity ?? 0) + row.grossQuantity * component.quantity,
        returnQuantity: (previous?.returnQuantity ?? 0) + row.returnQuantity * component.quantity,
        netQuantity: (previous?.netQuantity ?? 0) + row.netQuantity * component.quantity,
        salesAmount: (previous?.salesAmount ?? 0) + (index === 0 ? row.salesAmount : 0),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return { rows: [...rows.values()], skippedSkus: skipped };
}

function payoutRows(input: CyberbizReportIngestInput) {
  const rows = new Map<string, { scopeId: string; businessDate: string; payoutAmount: number; updatedAt: string }>();
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const businessDate = date(value.businessDate);
    const payoutAmount = integer(value.payoutAmount ?? 0);
    const previous = rows.get(businessDate);
    rows.set(businessDate, {
      scopeId: input.scopeId,
      businessDate,
      payoutAmount: (previous?.payoutAmount ?? 0) + payoutAmount,
      updatedAt: new Date().toISOString(),
    });
  }
  return [...rows.values()];
}

export function createCyberbizReportIngestor(db: Database) {
  return {
    async ingest(value: unknown): Promise<{
      kind: CyberbizReportIngestKind;
      scopeId: string;
      rowCount: number;
      salesRowCount?: number;
      payoutRowCount?: number;
      /** 對不到對應而被略過的外部 SKU；補好對應重跑同一個月就會補回來。 */
      skippedSkus?: string[];
    }> {
      const input = readInput(value);
      const sourceChannel = reportChannel(input.scopeId);
      const canReuseScopeByName = sourceChannel === "legacy" || sourceChannel === "cyberbiz";
      const existingById = await findReportScope(db, { scopeKind: input.scopeType, id: input.scopeId });
      const nameMatch = existingById ?? (
        !canReuseScopeByName
          ? null
          : await findReportScope(db, { scopeKind: input.scopeType, name: input.scopeName })
      );
      const nameMatchChannel = nameMatch ? reportChannel(nameMatch.id) : null;
      // 舊版 CYBERBIZ 設定可能使用任意 legacy ID，仍可依同名沿用；蝦皮則一定以自己的
      // scope ID 建立，不能因為名稱剛好相同而把資料寫進其他通路。
      const existing = existingById ?? (
        canReuseScopeByName
        && nameMatch
        && (nameMatchChannel === "legacy" || nameMatchChannel === sourceChannel)
          ? nameMatch
          : null
      );
      const scope = existing ?? await upsertReportScope(db, {
        id: input.scopeId,
        scopeKind: input.scopeType,
        name: input.scopeName,
      });
      const scopedInput = { ...input, scopeId: scope.id };
      if (input.kind === "sales_and_payout") {
        const salesInput = { ...scopedInput, rows: input.salesRows ?? [] };
        // 先驗證 sales 的資料格式，再寫入 payout；只有 mapping 不存在時才保留「先存 payout」的行為。
        const parsedSales = parseSalesRows(salesInput);
        const payout = payoutRows({ ...scopedInput, rows: input.payoutRows ?? [] });
        // payout 與商品 mapping 無關，先保存，避免新商品未 mapping 時連結帳金額也一起遺失。
        await insertReportPayoutDaily(db, payout);
        const sales = await normalizeSalesRows(db, salesInput, sourceChannel, parsedSales);
        await insertReportSalesMonthly(db, sales.rows, input.reportMonth
          ? { scopeId: scope.id, reportMonth: input.reportMonth }
          : undefined);
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.rows.length + payout.length,
          salesRowCount: sales.rows.length,
          payoutRowCount: payout.length,
          skippedSkus: sales.skippedSkus,
        };
      }
      if (input.kind === "sales") {
        const sales = await normalizeSalesRows(db, scopedInput, sourceChannel);
        await insertReportSalesMonthly(db, sales.rows, input.reportMonth
          ? { scopeId: scope.id, reportMonth: input.reportMonth }
          : undefined);
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.rows.length,
          skippedSkus: sales.skippedSkus,
        };
      }
      const rows = payoutRows(scopedInput);
      await insertReportPayoutDaily(db, rows);
      return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
    },
  };
}
