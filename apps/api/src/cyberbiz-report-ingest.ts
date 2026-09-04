import { eq, sql } from "drizzle-orm";
import {
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  findReportScope,
  upsertReportScope,
  normalizeExternalSku,
  reportDataChannel,
  reportScopeChannel,
  resolveIgnoredSkus,
  resolveProductSkus,
  type Database,
  type ReportScopeKind,
} from "@rueisiang/db";
import { items as itemMasters } from "@rueisiang/db/schema";
import { reportExternalProducts, reportIngestIssues, reportRunScopes, reportRuns, scopes } from "@rueisiang/db/schema";

export type CyberbizReportIngestKind = "sales" | "payout" | "sales_and_payout";

export interface CyberbizReportIngestInput {
  kind: CyberbizReportIngestKind;
  scopeType: ReportScopeKind;
  scopeId: string;
  scopeName: string;
  rows?: unknown[];
  /** 商品銷售以整月快照匯入；出金仍由 rows 內的 businessDate 決定。 */
  reportMonth?: string;
  /** 人工匯入的非完整月份只更新檔案內 SKU，保留同月未列出的既有資料。 */
  salesWriteMode?: "replace" | "merge";
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

/**
 * 加總與用料展開的結果也要檢查一次。
 *
 * 每一列各自都是安全整數，同 SKU 相加、再乘上組合用料數量之後仍可能溢位；不檢查的話
 * 會靜默寫入失真的數字。
 */
function total(value: number): number {
  if (!Number.isSafeInteger(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value;
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
  const salesWriteMode = value.salesWriteMode === undefined ? "replace" : value.salesWriteMode;
  if ((value.kind === "sales" || value.kind === "sales_and_payout")
    && salesWriteMode !== "replace" && salesWriteMode !== "merge") {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if (value.kind === "payout" && value.salesWriteMode !== undefined) {
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
    ...((value.kind === "sales" || value.kind === "sales_and_payout") && salesWriteMode === "merge"
      ? { salesWriteMode: "merge" as const }
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

function salesTotals(rows: ReadonlyArray<Pick<ParsedSalesRow, "grossQuantity" | "returnQuantity" | "netQuantity" | "salesAmount">>) {
  return rows.reduce((totals, row) => ({
    grossQuantity: totals.grossQuantity + row.grossQuantity,
    returnQuantity: totals.returnQuantity + row.returnQuantity,
    netQuantity: totals.netQuantity + row.netQuantity,
    salesAmount: totals.salesAmount + row.salesAmount,
  }), {
    grossQuantity: 0,
    returnQuantity: 0,
    netQuantity: 0,
    salesAmount: 0,
  });
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
      grossQuantity: total((previous?.grossQuantity ?? 0) + integer(value.grossQuantity ?? 0)),
      returnQuantity: total((previous?.returnQuantity ?? 0) + integer(value.returnQuantity ?? 0)),
      netQuantity: total((previous?.netQuantity ?? 0) + integer(value.netQuantity ?? 0)),
      salesAmount: total((previous?.salesAmount ?? 0) + integer(value.salesAmount ?? 0)),
    });
  }
  return [...rows.values()];
}

async function normalizeSalesRows(
  db: Database,
  input: CyberbizReportIngestInput,
  channel = reportDataChannel(input.scopeId),
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
  mappedProducts: Array<{ externalKey: string; externalName: string; systemSku: string }>;
  ignoredProducts: Array<{ externalKey: string; externalName: string; reason: string }>;
}> {
  const parsed = preparsed ?? parseSalesRows(input);
  if (!parsed.length) return { rows: [], skippedSkus: [], mappedProducts: [], ignoredProducts: [] };

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
  const ignoredProducts = [...new Set(parsed.filter((row) => ignored.has(row.externalSku)).map((row) => row.externalSku))].map((externalKey) => ({
    externalKey,
    externalName: "",
    reason: "匯入設定標記為不納入報表",
  }));
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
     * 名稱與分類直接取用料自己的來源（WMS 商品或自訂商品主檔），兩者都只有一份，
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
        grossQuantity: total((previous?.grossQuantity ?? 0) + row.grossQuantity * component.quantity),
        returnQuantity: total((previous?.returnQuantity ?? 0) + row.returnQuantity * component.quantity),
        netQuantity: total((previous?.netQuantity ?? 0) + row.netQuantity * component.quantity),
        salesAmount: total((previous?.salesAmount ?? 0) + (index === 0 ? row.salesAmount : 0)),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  const mappedProducts = [...new Set(usable.map((row) => row.externalSku))].flatMap((externalKey) => {
    const resolvedItem = resolved.get(externalKey);
    if (!resolvedItem || resolvedItem.components.length !== 1 || !resolvedItem.components[0]?.inventoryItemId) return [];
    return [{ externalKey, externalName: resolvedItem.externalName, systemSku: resolvedItem.components[0].sku }];
  });
  return { rows: [...rows.values()], skippedSkus: skipped, mappedProducts, ignoredProducts };
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
      payoutAmount: total((previous?.payoutAmount ?? 0) + payoutAmount),
      updatedAt: new Date().toISOString(),
    });
  }
  return [...rows.values()];
}

async function recordMappedProducts(db: Database, sourceType: string, products: readonly { externalKey: string; externalName: string; systemSku: string }[]): Promise<void> {
  const values = [];
  for (const product of products) {
    const [item] = await db.select({ id: itemMasters.id }).from(itemMasters).where(sql`lower(${itemMasters.sku}) = lower(${product.systemSku})`).limit(1);
    if (item) values.push({ id: crypto.randomUUID(), sourceType, externalKey: product.externalKey, externalVariantKey: "", externalName: product.externalName, resolution: "mapped" as const, itemId: item.id, ignoredReason: "" });
  }
  if (!values.length) return;
  await db.insert(reportExternalProducts).values(values).onConflictDoUpdate({
    target: [reportExternalProducts.sourceType, reportExternalProducts.externalKey, reportExternalProducts.externalVariantKey],
    set: { externalName: sql`excluded.external_name`, resolution: "mapped", itemId: sql`excluded.item_id`, updatedAt: sql`CURRENT_TIMESTAMP` },
  });
}

async function recordIgnoredProducts(db: Database, sourceType: string, products: readonly { externalKey: string; externalName: string; reason: string }[]): Promise<void> {
  if (!products.length) return;
  await db.insert(reportExternalProducts).values(products.map((product) => ({
    id: crypto.randomUUID(), sourceType, externalKey: product.externalKey, externalVariantKey: "", externalName: product.externalName, resolution: "ignored" as const, itemId: null, ignoredReason: product.reason,
  }))).onConflictDoUpdate({
    target: [reportExternalProducts.sourceType, reportExternalProducts.externalKey, reportExternalProducts.externalVariantKey],
    set: { externalName: sql`excluded.external_name`, resolution: "ignored", itemId: null, ignoredReason: sql`excluded.ignored_reason`, updatedAt: sql`CURRENT_TIMESTAMP` },
  });
}

async function recordUnmappedIssues(db: Database, runId: string | null, skippedSkus: readonly string[]): Promise<void> {
  if (!runId || !skippedSkus.length) return;
  await db.insert(reportIngestIssues).values(skippedSkus.map((externalKey) => ({
    reportRunId: runId,
    externalKey,
    externalVariantKey: "",
    externalName: "",
    issueType: "unmapped" as const,
    detail: "找不到可用的品項或 SKU 對應。",
    rowCount: 1,
  }))).onConflictDoUpdate({
    target: [reportIngestIssues.reportRunId, reportIngestIssues.externalKey, reportIngestIssues.externalVariantKey, reportIngestIssues.issueType],
    set: { detail: "找不到可用的品項或 SKU 對應。", rowCount: 1 },
  });
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
      /** 實際完成 SKU mapping 後寫入報表的銷售合計。 */
      salesTotals?: {
        grossQuantity: number;
        returnQuantity: number;
        netQuantity: number;
        salesAmount: number;
      };
    }> {
      const input = readInput(value);
      // 沿用既有 scope 看的是 scope 自己的通路，不是資料通路：manual 據點也放 CYBERBIZ
      // 商品，但它必須是自己的 scope，不能因為同名就寫進自動匯入那家店。
      const scopeChannel = reportScopeChannel(input.scopeId);
      const dataChannel = reportDataChannel(input.scopeId);
      const canReuseScopeByName = scopeChannel === "legacy" || scopeChannel === "cyberbiz";
      const existingById = await findReportScope(db, { scopeKind: input.scopeType, id: input.scopeId });
      const nameMatch = existingById ?? (
        !canReuseScopeByName
          ? null
          : await findReportScope(db, { scopeKind: input.scopeType, name: input.scopeName })
      );
      const nameMatchChannel = nameMatch ? reportScopeChannel(nameMatch.id) : null;
      // 舊版 CYBERBIZ 設定可能使用任意 legacy ID，仍可依同名沿用；蝦皮則一定以自己的
      // scope ID 建立，不能因為名稱剛好相同而把資料寫進其他通路。
      const existing = existingById ?? (
        canReuseScopeByName
        && nameMatch
        && (nameMatchChannel === "legacy" || nameMatchChannel === scopeChannel)
          ? nameMatch
          : null
      );
      const scope = existing ?? await upsertReportScope(db, {
        id: input.scopeId,
        scopeKind: input.scopeType,
        name: input.scopeName,
      });
      const scopedInput = { ...input, scopeId: scope.id };
      const [targetScope] = await db.select({ id: scopes.id }).from(scopes).where(eq(scopes.id, scope.id)).limit(1);
      const runId = targetScope ? crypto.randomUUID() : null;
      const requestId = runId ? `cyberbiz-ingest:${scope.id}:${input.reportMonth ?? "adhoc"}:${runId}` : "";
      const payoutDates = (input.payoutRows ?? []).flatMap((row) => record(row) && typeof row.businessDate === "string" ? [row.businessDate] : []);
      const startDate = input.reportMonth ? `${input.reportMonth}-01` : (payoutDates.sort()[0] ?? new Date().toISOString().slice(0, 10));
      const endDate = input.reportMonth ? new Date(Date.UTC(Number(input.reportMonth.slice(0, 4)), Number(input.reportMonth.slice(5, 7)), 0)).toISOString().slice(0, 10) : (payoutDates.sort().at(-1) ?? startDate);
      if (runId) await db.batch([
        db.insert(reportRuns).values({ id: runId, requestId, sourceType: dataChannel, importsSales: input.kind !== "payout" ? 1 : 0, importsPayout: input.kind !== "sales" ? 1 : 0, periodKind: input.reportMonth ? "month" : "custom", startDate, endDate, status: "running", actorEmail: "" }),
        db.insert(reportRunScopes).values({ reportRunId: runId, scopeId: scope.id }),
      ]);
      try {
        if (input.kind === "sales_and_payout") {
        const salesInput = { ...scopedInput, rows: input.salesRows ?? [] };
        // 先驗證 sales 的資料格式，再寫入 payout；只有 mapping 不存在時才保留「先存 payout」的行為。
        const parsedSales = parseSalesRows(salesInput);
        const payout = payoutRows({ ...scopedInput, rows: input.payoutRows ?? [] });
        // payout 與商品 mapping 無關，先保存，避免新商品未 mapping 時連結帳金額也一起遺失。
        await insertReportPayoutDaily(db, payout, runId ?? undefined);
        const sales = await normalizeSalesRows(db, salesInput, dataChannel, parsedSales);
        await recordUnmappedIssues(db, runId, sales.skippedSkus);
        await recordMappedProducts(db, dataChannel, sales.mappedProducts);
        await recordIgnoredProducts(db, dataChannel, sales.ignoredProducts);
        await insertReportSalesMonthly(db, sales.rows, input.reportMonth
          ? {
            scopeId: scope.id,
            reportMonth: input.reportMonth,
            replaceExisting: input.salesWriteMode !== "merge",
            ...(runId ? { reportRunId: runId } : {}),
          }
          : undefined);
        if (runId) await db.update(reportRuns).set({ status: "succeeded", importedSalesRows: sales.rows.length, importedPayoutRows: payout.length, skippedRows: sales.skippedSkus.length, updatedAt: new Date().toISOString() }).where(eq(reportRuns.id, runId));
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.rows.length + payout.length,
          salesRowCount: sales.rows.length,
          payoutRowCount: payout.length,
          skippedSkus: sales.skippedSkus,
          salesTotals: salesTotals(sales.rows),
        };
      }
      if (input.kind === "sales") {
        const sales = await normalizeSalesRows(db, scopedInput, dataChannel);
        await recordUnmappedIssues(db, runId, sales.skippedSkus);
        await recordMappedProducts(db, dataChannel, sales.mappedProducts);
        await recordIgnoredProducts(db, dataChannel, sales.ignoredProducts);
        await insertReportSalesMonthly(db, sales.rows, input.reportMonth
          ? {
            scopeId: scope.id,
            reportMonth: input.reportMonth,
            replaceExisting: input.salesWriteMode !== "merge",
            ...(runId ? { reportRunId: runId } : {}),
          }
          : undefined);
        if (runId) await db.update(reportRuns).set({ status: "succeeded", importedSalesRows: sales.rows.length, skippedRows: sales.skippedSkus.length, updatedAt: new Date().toISOString() }).where(eq(reportRuns.id, runId));
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.rows.length,
          skippedSkus: sales.skippedSkus,
          salesTotals: salesTotals(sales.rows),
        };
      }
      const rows = payoutRows(scopedInput);
      await insertReportPayoutDaily(db, rows, runId ?? undefined);
      if (runId) await db.update(reportRuns).set({ status: "succeeded", importedPayoutRows: rows.length, updatedAt: new Date().toISOString() }).where(eq(reportRuns.id, runId));
      return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
      } catch (error) {
        if (runId) await db.update(reportRuns).set({ status: "failed", lastError: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }).where(eq(reportRuns.id, runId));
        throw error;
      }
    },
  };
}
