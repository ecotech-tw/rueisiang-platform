import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { Switch } from "../../shell/Switch.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateManualPayout,
  useCreateManualSales,
  useDeleteManualPayout,
  useDeleteManualSales,
  useCreateManualScope,
  useDeleteManualScope,
  useImportManualPayout,
  useImportManualSales,
  useManualPayouts,
  useManualReportOptions,
  useManualReportScopes,
  useManualSales,
  useUpdateManualPayout,
  useUpdateManualScope,
  useUpdateManualSales,
  type ManualPayoutInput,
  type ManualPayoutQuery,
  type ManualPayoutRow,
  type ManualProductOption,
  type ManualReportKind,
  type ManualSalesInput,
  type ManualSalesQuery,
  type ManualSalesRow,
  type ManualScopeOption,
  type ManualManagementScope,
  type ManualSkuSource,
} from "./manual-reports-api.js";
import {
  detectPayout,
  payoutHeaders,
  summarisePayout,
  type PayoutDayRow,
} from "./manual-report-import.js";
import {
  parseManualCyberbizSales,
  resolveManualSalesPreview,
  type ManualSalesPreview,
} from "./cyberbiz-sales-xlsx.js";
import { readFirstSheet, type Sheet } from "./xlsx.js";

type DialogState =
  | { kind: "payout"; row?: ManualPayoutRow }
  | { kind: "sales"; row?: ManualSalesRow };

type DeletingState =
  | { kind: "payout"; row: ManualPayoutRow }
  | { kind: "sales"; row: ManualSalesRow };

type ImportDialogState = { kind: ManualReportKind };

function formatCurrency(value: number): string {
  return `NT$${value.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function parseSafeInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isWholeMonthRange(start: string, end: string): boolean {
  if (start.slice(0, 7) !== end.slice(0, 7)) return false;
  const [year, month] = start.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return start === `${start.slice(0, 7)}-01`
    && end === `${start.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

const PAGE_SIZES = [10, 25, 50, 100] as const;

const DEFAULT_PAYOUT_FILTERS: ManualPayoutQuery = {
  page: 1,
  pageSize: 25,
  search: "",
  scopeId: "",
  source: "all",
  startDate: "",
  endDate: "",
  sortField: "businessDate",
  sortDirection: "desc",
};

const DEFAULT_SALES_FILTERS: ManualSalesQuery = {
  page: 1,
  pageSize: 25,
  search: "",
  scopeId: "",
  source: "all",
  startMonth: "",
  endMonth: "",
  sortField: "reportMonth",
  sortDirection: "desc",
};

function ErrorMessage({ error }: { error: Error | null | undefined }) {
  return error ? <Alert tone="danger">{error.message}</Alert> : null;
}

function ManualReportDialog({
  state,
  scopes,
  products,
  onClose,
}: {
  state: DialogState;
  scopes: ManualScopeOption[];
  products: ManualProductOption[];
  onClose: () => void;
}) {
  const createPayout = useCreateManualPayout();
  const updatePayout = useUpdateManualPayout();
  const createSales = useCreateManualSales();
  const updateSales = useUpdateManualSales();
  const [scopeId, setScopeId] = useState(state.row?.scopeId ?? scopes[0]?.id ?? "");
  const [businessDate, setBusinessDate] = useState(state.kind === "payout" ? state.row?.businessDate ?? "" : "");
  const [payoutAmount, setPayoutAmount] = useState(state.kind === "payout" ? String(state.row?.payoutAmount ?? "") : "");
  const [reportMonth, setReportMonth] = useState(state.kind === "sales" ? state.row?.reportMonth ?? "" : "");
  const [skuSource, setSkuSource] = useState<ManualSkuSource>(() => {
    if (state.kind !== "sales") return "cyberbiz";
    if (state.row?.skuSource) return state.row.skuSource;
    return state.row && products.some((product) => product.sku === state.row?.sku) ? "cyberbiz" : "custom";
  });
  const [sku, setSku] = useState(state.kind === "sales" ? state.row?.sku ?? "" : "");
  const [productName, setProductName] = useState(state.kind === "sales" ? state.row?.productName ?? "" : "");
  const [category, setCategory] = useState(state.kind === "sales" ? state.row?.category ?? "未分類" : "未分類");
  const [grossQuantity, setGrossQuantity] = useState(state.kind === "sales" ? String(state.row?.grossQuantity ?? "") : "");
  const [returnQuantity, setReturnQuantity] = useState(state.kind === "sales" ? String(state.row?.returnQuantity ?? "") : "");
  const [netQuantity, setNetQuantity] = useState(state.kind === "sales" ? String(state.row?.netQuantity ?? "") : "");
  const [salesAmount, setSalesAmount] = useState(state.kind === "sales" ? String(state.row?.salesAmount ?? "") : "");

  const selectedProduct = products.find((product) => product.sku === sku);
  const productOptions = useMemo(() => {
    if (skuSource !== "cyberbiz") return [];
    const options = [...products];
    if (sku && !options.some((product) => product.sku === sku)) {
      options.unshift({ sku, name: productName || sku, published: true });
    }
    return options;
  }, [productName, products, sku, skuSource]);
  const payoutValue = parseSafeInteger(payoutAmount);
  const salesValues = {
    grossQuantity: parseSafeInteger(grossQuantity),
    returnQuantity: parseSafeInteger(returnQuantity),
    netQuantity: parseSafeInteger(netQuantity),
    salesAmount: parseSafeInteger(salesAmount),
  };
  const valid = state.kind === "payout"
    ? Boolean(scopeId && businessDate && payoutValue !== null)
    : Boolean(
      scopeId
      && reportMonth
      && sku
      && (skuSource === "cyberbiz" ? selectedProduct || productOptions.some((product) => product.sku === sku) : productName.trim())
      && Object.values(salesValues).every((value) => value !== null),
    );
  const pending = createPayout.isPending || updatePayout.isPending || createSales.isPending || updateSales.isPending;
  const error = createPayout.error ?? updatePayout.error ?? createSales.error ?? updateSales.error;
  const scopeOptions = [
    { label: "請選擇據點", value: "" },
    ...scopes.map((scope) => ({ label: scope.name, value: scope.id })),
  ];

  function submit() {
    if (!valid) return;
    if (state.kind === "payout" && payoutValue !== null) {
      const input: ManualPayoutInput = { scopeId, businessDate, payoutAmount: payoutValue };
      const onSuccess = () => onClose();
      if (state.row?.source === "manual") updatePayout.mutate({ ...input, id: state.row.id }, { onSuccess });
      else createPayout.mutate(input, { onSuccess });
      return;
    }
    if (state.kind === "sales") {
      const input: ManualSalesInput = {
        scopeId,
        reportMonth,
        skuSource,
        sku,
        ...(skuSource === "custom" ? { productName: productName.trim(), category: category.trim() || "未分類" } : {}),
        grossQuantity: salesValues.grossQuantity ?? 0,
        returnQuantity: salesValues.returnQuantity ?? 0,
        netQuantity: salesValues.netQuantity ?? 0,
        salesAmount: salesValues.salesAmount ?? 0,
      };
      const onSuccess = () => onClose();
      if (state.row?.source === "manual") updateSales.mutate({ ...input, id: state.row.id }, { onSuccess });
      else createSales.mutate(input, { onSuccess });
    }
  }

  return (
    <Dialog
      title={`${state.row ? "編輯" : "新增"}${state.kind === "payout" ? "出金資料" : "商品銷售資料"}`}
      className="manual-report-dialog"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" loading={pending} loadingLabel="處理中…" disabled={!valid}>確認</Button>
        </>
      }
    >
      <div className="manual-report-form">
        <SelectField
          label="據點"
          required
          value={scopeId}
          onChange={(event) => setScopeId(event.target.value)}
          options={scopeOptions}
          disabled={pending}
        />

        {state.kind === "payout" ? (
          <div className="field-grid">
            <TextField
              label="出金日期"
              required
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
              disabled={pending}
            />
            <TextField
              label="出金金額"
              required
              type="number"
              step="1"
              inputMode="numeric"
              value={payoutAmount}
              onChange={(event) => setPayoutAmount(event.target.value)}
              disabled={pending}
            />
          </div>
        ) : (
          <>
            <div className="field-grid">
              <TextField
                label="報表月份"
                required
                type="month"
                value={reportMonth}
                onChange={(event) => setReportMonth(event.target.value)}
                disabled={pending}
              />
              <SelectField
                label="SKU 來源"
                required
                value={skuSource}
                onChange={(event) => {
                  const next = event.target.value as ManualSkuSource;
                  setSkuSource(next);
                  setSku("");
                  setProductName("");
                  setCategory("未分類");
                }}
                options={[
                  { label: "CYBERBIZ 商品", value: "cyberbiz" },
                  { label: "自訂 SKU", value: "custom" },
                ]}
                disabled={pending}
              />
            </div>
            {skuSource === "cyberbiz" ? (
              <>
                <SelectField
                  label="CYBERBIZ SKU"
                  required
                  value={sku}
                  onChange={(event) => {
                    const nextSku = event.target.value;
                    const product = products.find((item) => item.sku === nextSku);
                    setSku(nextSku);
                    setProductName(product?.name ?? nextSku);
                  }}
                  options={[
                    { label: "請選擇商品", value: "" },
                    ...productOptions.map((product) => ({
                      label: `${product.sku} · ${product.name}${product.published ? "" : "（已下架）"}`,
                      value: product.sku,
                    })),
                  ]}
                  disabled={pending}
                />
                <TextField label="商品名稱" value={productName} readOnly hint="名稱會取自 CYBERBIZ 商品目錄。" />
              </>
            ) : (
              <div className="field-grid">
                <TextField
                  label="自訂 SKU"
                  required
                  value={sku}
                  onChange={(event) => setSku(event.target.value)}
                  disabled={pending}
                />
                <TextField
                  label="商品名稱"
                  required
                  value={productName}
                  onChange={(event) => setProductName(event.target.value)}
                  disabled={pending}
                />
                <TextField
                  label="分類"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  disabled={pending}
                />
              </div>
            )}
            <div className="field-grid trio">
              <TextField
                label="銷售數量"
                required
                type="number"
                step="1"
                inputMode="numeric"
                value={grossQuantity}
                onChange={(event) => setGrossQuantity(event.target.value)}
                disabled={pending}
              />
              <TextField
                label="退貨數量"
                required
                type="number"
                step="1"
                inputMode="numeric"
                value={returnQuantity}
                onChange={(event) => setReturnQuantity(event.target.value)}
                disabled={pending}
              />
              <TextField
                label="淨銷售數量"
                required
                type="number"
                step="1"
                inputMode="numeric"
                value={netQuantity}
                onChange={(event) => setNetQuantity(event.target.value)}
                disabled={pending}
              />
            </div>
            <TextField
              label="銷售金額"
              required
              type="number"
              step="1"
              inputMode="numeric"
              value={salesAmount}
              onChange={(event) => setSalesAmount(event.target.value)}
              disabled={pending}
            />
          </>
        )}
        <ErrorMessage error={error} />
      </div>
    </Dialog>
  );
}

function ReportImportDialog({
  kind,
  scopes,
  products,
  onClose,
}: {
  kind: ManualReportKind;
  scopes: ManualScopeOption[];
  products: ManualProductOption[];
  onClose: () => void;
}) {
  const importPayout = useImportManualPayout();
  const importSales = useImportManualSales();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [salesPreview, setSalesPreview] = useState<ManualSalesPreview | null>(null);
  const [parseError, setParseError] = useState("");
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");
  const [scopeName, setScopeName] = useState("");
  const [headerRow, setHeaderRow] = useState(2);
  const [dateColumn, setDateColumn] = useState("");
  const [amountColumn, setAmountColumn] = useState("");

  const detected = useMemo(() => kind === "payout" && sheet ? detectPayout(sheet) : null, [kind, sheet]);
  const headers = useMemo(() => sheet ? payoutHeaders(sheet, headerRow) : [], [headerRow, sheet]);
  const payoutPreview = useMemo(() => {
    if (kind !== "payout" || !sheet || !dateColumn || !amountColumn) return null;
    return summarisePayout(sheet, headerRow, dateColumn, amountColumn);
  }, [amountColumn, dateColumn, headerRow, kind, sheet]);
  const resolvedSalesPreview = useMemo(
    () => salesPreview ? resolveManualSalesPreview(salesPreview, products) : null,
    [products, salesPreview],
  );
  const salesImportRows = resolvedSalesPreview?.rows.filter((row) => row.sku.trim()) ?? [];
  const unresolvedProductNames = resolvedSalesPreview?.unresolvedProductNames ?? [];
  const salesIsWholeMonth = resolvedSalesPreview
    ? isWholeMonthRange(resolvedSalesPreview.coverageStart, resolvedSalesPreview.coverageEnd)
    : true;
  const salesIsCrossMonth = resolvedSalesPreview
    ? resolvedSalesPreview.coverageStart.slice(0, 7) !== resolvedSalesPreview.coverageEnd.slice(0, 7)
    : false;
  const selectedScopeName = scopeId ? scopes.find((scope) => scope.id === scopeId)?.name ?? "" : scopeName.trim();
  const pending = importPayout.isPending || importSales.isPending;
  const error = parseError || importPayout.error?.message || importSales.error?.message || "";
  const valid = Boolean(
    selectedScopeName
    && (kind === "payout"
      ? payoutPreview?.days.length
      : salesImportRows.length && !unresolvedProductNames.length),
  );

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setSheet(null);
    setSalesPreview(null);
    setParseError("");
    setDateColumn("");
    setAmountColumn("");
    try {
      const parsed = await readFirstSheet(file);
      if (kind === "payout") {
        setSheet(parsed);
        const found = detectPayout(parsed);
        if (found) {
          setHeaderRow(found.headerRow);
          setDateColumn(found.dateColumn);
          setAmountColumn(found.amountColumn);
        } else {
          setHeaderRow(2);
          setParseError("找不到出金報表的日期或金額欄位，請手動選擇欄位。");
        }
      } else {
        setSalesPreview(parseManualCyberbizSales(parsed));
      }
    } catch (parseFailure) {
      setParseError(parseFailure instanceof Error ? parseFailure.message : "讀不開這個檔案。");
    }
  }

  function submit() {
    if (!valid || !selectedScopeName) return;
    if (kind === "payout" && payoutPreview) {
      importPayout.mutate({
        scopeName: selectedScopeName,
        ...(scopeId ? { scopeId } : {}),
        rows: payoutPreview.days.map((day) => ({ businessDate: day.businessDate, payoutAmount: day.payoutAmount })),
      }, {
        onSuccess: (result) => {
          toast.show(`已匯入${result.scopeName} ${result.dayCount} 天，合計 ${result.total.toLocaleString("zh-TW")}`);
          if (fileInputRef.current) fileInputRef.current.value = "";
          onClose();
        },
      });
      return;
    }
    if (kind === "sales" && resolvedSalesPreview) {
      importSales.mutate({
        scopeName: selectedScopeName,
        ...(scopeId ? { scopeId } : {}),
        reportMonth: resolvedSalesPreview.reportMonth,
        rows: salesImportRows.map(({ sku, productName, category, grossQuantity, returnQuantity, netQuantity, salesAmount }) => ({
          sku,
          productName,
          category,
          grossQuantity,
          returnQuantity,
          netQuantity,
          salesAmount,
        })),
      }, {
        onSuccess: (result) => {
          const skipped = result.skippedSkus?.length ? `，略過 ${result.skippedSkus.length} 個未完成 mapping 的 SKU` : "";
          toast.show(`已匯入${result.scopeName} ${result.reportMonth} ${result.rowCount} 筆商品銷售資料${skipped}`);
          if (fileInputRef.current) fileInputRef.current.value = "";
          onClose();
        },
      });
    }
  }

  return (
    <Dialog
      title={`匯入${kind === "payout" ? "出金" : "商品銷售"}報表`}
      className="manual-report-import-dialog"
      backdropClassName="manual-report-import-backdrop"
      bodyClassName="manual-report-import-body"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" loading={pending} loadingLabel="匯入中…" disabled={!valid}>確認匯入</Button>
        </>
      }
    >
      <div className="manual-report-import-form">
        <div className="field-grid">
          <SelectField
            label="據點"
            required
            value={scopeId}
            onChange={(event) => {
              setScopeId(event.target.value);
              if (event.target.value) setScopeName("");
            }}
            options={[
              { label: scopes.length ? "新增據點…" : "輸入新據點", value: "" },
              ...scopes.map((scope) => ({ label: scope.name, value: scope.id })),
            ]}
            disabled={pending}
          />
          {!scopeId ? (
            <TextField
              label="新據點名稱"
              required
              value={scopeName}
              onChange={(event) => setScopeName(event.target.value)}
              disabled={pending}
            />
          ) : <div />}
        </div>

        <label className="manual-report-file-picker">
          <span className="field-label">報表檔案</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void pickFile(event.target.files?.[0])}
            disabled={pending}
          />
          {fileName ? <span className="form-hint">{fileName}</span> : null}
        </label>

        {kind === "payout" && sheet ? (
          <div className="field-grid trio manual-report-import-fields">
            <SelectField
              label="標題列"
              value={String(headerRow)}
              onChange={(event) => {
                setHeaderRow(Number(event.target.value));
                setDateColumn("");
                setAmountColumn("");
              }}
              options={[1, 2, 3].map((row) => ({ label: `第 ${row} 列`, value: String(row) }))}
              disabled={pending}
            />
            <SelectField
              label="日期欄"
              value={dateColumn}
              onChange={(event) => setDateColumn(event.target.value)}
              options={[{ label: "請選擇", value: "" }, ...headers.map((entry) => ({
                label: `${entry.column}：${entry.label}`,
                value: entry.column,
              }))]}
              disabled={pending}
            />
            <SelectField
              label="金額欄"
              value={amountColumn}
              onChange={(event) => setAmountColumn(event.target.value)}
              options={[{ label: "請選擇", value: "" }, ...headers.map((entry) => ({
                label: `${entry.column}：${entry.label}`,
                value: entry.column,
              }))]}
              disabled={pending}
            />
          </div>
        ) : null}

        {detected && kind === "payout" && !parseError ? <p className="form-hint">已自動選擇日期與金額欄位，可在上方調整。</p> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}

        {kind === "payout" && payoutPreview ? (
          <section className="manual-report-import-preview">
            <div className="manual-report-import-preview-head">
              <div>
                <h3>預覽</h3>
                <p className="muted">
                  {payoutPreview.days[0]?.businessDate} ~ {payoutPreview.days.at(-1)?.businessDate}，共 {payoutPreview.days.length} 天，合計 {formatCurrency(payoutPreview.total)}
                </p>
              </div>
              <span className="form-hint">確認後才會寫入</span>
            </div>
            {payoutPreview.skipped.length ? <Alert tone="warning">有 {payoutPreview.skipped.length} 列無法解析，已略過。</Alert> : null}
            <div className="table-scroll manual-report-import-table-scroll">
              <table className="data-table">
                <thead><tr><th>日期</th><th className="numeric">金額</th><th className="numeric">原始列數</th></tr></thead>
                <tbody>
                  {payoutPreview.days.map((day: PayoutDayRow) => (
                    <tr key={day.businessDate}>
                      <td>{day.businessDate}</td>
                      <td className="numeric">{formatCurrency(day.payoutAmount)}</td>
                      <td className="numeric">{day.rowCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {kind === "sales" && resolvedSalesPreview ? (
          <section className="manual-report-import-preview">
            <div className="manual-report-import-preview-head">
              <div>
                <h3>預覽</h3>
                <p className="muted">{resolvedSalesPreview.coverageStart} ~ {resolvedSalesPreview.coverageEnd}，共 {resolvedSalesPreview.rows.length} 筆商品</p>
              </div>
              <span className="form-hint">確認後才會寫入</span>
            </div>
            {!salesIsWholeMonth ? (
              <Alert tone="warning">
                這份報表不是完整月份；匯入只會更新檔案內列出的 SKU，既有但未列出的資料會保留。
                {salesIsCrossMonth ? "跨月份資料會以報表起始月份歸檔，不會拆分到不同月份。" : ""}
              </Alert>
            ) : null}
            {resolvedSalesPreview.skippedRows.length ? <Alert tone="warning">有 {resolvedSalesPreview.skippedRows.length} 列沒有 SKU，已略過。</Alert> : null}
            {unresolvedProductNames.length ? (
              <Alert tone="warning">
                有 {unresolvedProductNames.length} 個商品名稱尚未唯一對應到 CYBERBIZ SKU，請在下方補上 SKU 後才能匯入：
                {unresolvedProductNames.slice(0, 10).join("、")}
                {unresolvedProductNames.length > 10 ? " 等" : ""}。
              </Alert>
            ) : null}
            <div className="table-scroll manual-report-import-table-scroll">
              <table className="data-table manual-sales-table">
                <thead><tr><th>來源列</th><th>SKU</th><th>商品名稱</th><th>類別</th><th className="numeric">銷售數量</th><th className="numeric">退回數量</th><th className="numeric">淨銷售數量</th><th className="numeric">售額</th></tr></thead>
                <tbody>
                  {resolvedSalesPreview.rows.map((row) => (
                    <tr key={row.sourceRow}>
                      <td>{row.sourceRow}</td>
                      <td>
                        <input
                          className="cell-input manual-sales-sku-input"
                          value={row.sku}
                          placeholder="輸入 SKU"
                          onChange={(event) => {
                            const value = event.target.value;
                            setSalesPreview((current) => current
                              ? { ...current, rows: current.rows.map((candidate) => candidate.sourceRow === row.sourceRow ? { ...candidate, sku: value } : candidate) }
                              : current);
                          }}
                          disabled={pending}
                          aria-label={`第 ${row.sourceRow} 列 SKU`}
                        />
                      </td>
                      <td>{row.productName || "—"}</td>
                      <td>{row.category}</td>
                      <td className="numeric">{row.grossQuantity.toLocaleString("zh-TW")}</td>
                      <td className="numeric">{row.returnQuantity.toLocaleString("zh-TW")}</td>
                      <td className="numeric">{row.netQuantity.toLocaleString("zh-TW")}</td>
                      <td className="numeric">{formatCurrency(row.salesAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

function ScopeManagementDialog({
  scopes,
  onClose,
}: {
  scopes: ManualManagementScope[];
  onClose: () => void;
}) {
  const createScope = useCreateManualScope();
  const updateScope = useUpdateManualScope();
  const deleteScope = useDeleteManualScope();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<ManualManagementScope | null>(null);
  const pending = createScope.isPending || updateScope.isPending || deleteScope.isPending;

  function create() {
    const name = newName.trim();
    if (!name) return;
    createScope.mutate({ name }, {
      onSuccess: (result) => {
        setNewName("");
        toast.show(`已新增據點「${result.scope.name}」`);
      },
    });
  }

  function saveName() {
    if (!editing || !editing.name.trim()) return;
    updateScope.mutate({ id: editing.id, name: editing.name.trim() }, {
      onSuccess: (result) => {
        setEditing(null);
        toast.show(`已更新據點「${result.scope.name}」`);
      },
    });
  }

  function toggle(scope: ManualManagementScope, active: boolean) {
    updateScope.mutate({ id: scope.id, name: scope.name, active }, {
      onSuccess: () => toast.show(active ? `已啟用據點「${scope.name}」` : `已停用據點「${scope.name}」`),
    });
  }

  return (
    <>
      <Dialog
        title="管理報表據點"
        className="manual-scope-dialog"
        onClose={onClose}
        closeDisabled={pending}
        actions={<Button variant="secondary" type="button" onClick={onClose} disabled={pending}>關閉</Button>}
      >
        <div className="manual-scope-manager">
          <form className="admin-form toolbar manual-scope-create" onSubmit={(event) => { event.preventDefault(); create(); }}>
            <TextField
              label="新增據點"
              required
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如：中友百貨"
              disabled={pending}
            />
            <Button type="submit" icon="plus" loading={createScope.isPending} disabled={!newName.trim() || pending}>新增</Button>
          </form>
          {createScope.error ? <ErrorMessage error={createScope.error} /> : null}
          {updateScope.error ? <ErrorMessage error={updateScope.error} /> : null}
          {deleteScope.error ? <ErrorMessage error={deleteScope.error} /> : null}
          <div className="table-scroll">
            <table className="data-table manual-scope-table">
              <thead><tr><th>據點</th><th>狀態</th><th /></tr></thead>
              <tbody>
                {scopes.map((scope) => (
                  <tr key={scope.id}>
                    <td>
                      {editing?.id === scope.id ? (
                        <input
                          className="cell-input"
                          value={editing.name}
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                          aria-label={`編輯${scope.name}據點名稱`}
                          disabled={pending}
                        />
                      ) : <span className="cell-strong">{scope.name}</span>}
                      <small className="cell-sub">{scope.id}</small>
                    </td>
                    <td data-label="狀態">
                      <div className="report-scope-toggle">
                        <Switch
                          checked={scope.active}
                          busy={pending}
                          onChange={(active) => toggle(scope, active)}
                          label={`${scope.name}報表據點啟用狀態`}
                        />
                        <span>{scope.active ? "啟用" : "停用"}</span>
                      </div>
                    </td>
                    <td data-label="操作">
                      <div className="row-actions">
                        {editing?.id === scope.id ? (
                          <>
                            <Button variant="secondary" disabled={pending || !editing.name.trim()} onClick={saveName}>儲存</Button>
                            <Button variant="link" disabled={pending} onClick={() => setEditing(null)}>取消</Button>
                          </>
                        ) : (
                          <Button variant="icon" icon="edit" disabled={pending} onClick={() => setEditing({ id: scope.id, name: scope.name })} title={`編輯${scope.name}`} aria-label={`編輯${scope.name}`} />
                        )}
                        {scope.active ? (
                          <Button variant="icon" className="danger" icon="trash" disabled={pending} onClick={() => setDeleting(scope)} title={`停用${scope.name}`} aria-label={`停用${scope.name}`} />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!scopes.length ? <p className="manual-report-empty">目前沒有報表據點。</p> : null}
          <p className="muted">停用只會從選單與報表執行頁隱藏，既有紀錄會保留。</p>
        </div>
      </Dialog>
      {deleting ? (
        <ConfirmDialog
          title={`停用「${deleting.name}」？`}
          confirmLabel="停用據點"
          pending={deleteScope.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            deleteScope.mutate(target.id, { onSuccess: () => toast.show(`已停用據點「${target.name}」`) });
          }}
        >
          <p><strong>{deleting.name}</strong> 會從報表管理的據點選單移除。</p>
          <p className="muted">既有出金與商品銷售紀錄不會被刪除，之後仍可重新啟用。</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function ManualReports() {
  usePageTitle("報表管理");
  const { permissions } = useSession();
  const canWrite = permissions.has("reports:cyberbiz:write");
  const optionsQuery = useManualReportOptions(canWrite);
  const scopesQuery = useManualReportScopes(canWrite);
  const [payoutFilters, setPayoutFilters] = useState<ManualPayoutQuery>(DEFAULT_PAYOUT_FILTERS);
  const [salesFilters, setSalesFilters] = useState<ManualSalesQuery>(DEFAULT_SALES_FILTERS);
  const payoutsQuery = useManualPayouts(payoutFilters, canWrite);
  const salesQuery = useManualSales(salesFilters, canWrite);
  const deletePayout = useDeleteManualPayout();
  const deleteSales = useDeleteManualSales();
  const toast = useToast();
  const [kind, setKind] = useState<ManualReportKind>("payout");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [scopeDialog, setScopeDialog] = useState(false);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);

  const scopes = optionsQuery.data?.scopes ?? [];
  const products = optionsQuery.data?.products ?? [];
  const payoutPage = payoutsQuery.data;
  const salesPage = salesQuery.data;
  const managementScopes = scopesQuery.data?.scopes ?? [];
  const queryError = optionsQuery.error ?? scopesQuery.error ?? (kind === "payout" ? payoutsQuery.error : salesQuery.error);
  const busy = deletePayout.isPending || deleteSales.isPending;
  const dialogScopes = dialog?.row && !scopes.some((scope) => scope.id === dialog.row?.scopeId)
    ? [{ id: dialog.row.scopeId, name: `${dialog.row.scopeName}（已停用）` }, ...scopes]
    : scopes;

  useEffect(() => {
    const totalPages = payoutPage ? Math.max(1, Math.ceil(payoutPage.total / payoutPage.pageSize)) : 1;
    if (payoutPage && payoutFilters.page > totalPages) {
      setPayoutFilters((current) => ({ ...current, page: totalPages }));
    }
  }, [payoutFilters.page, payoutPage?.pageSize, payoutPage?.total]);

  useEffect(() => {
    const totalPages = salesPage ? Math.max(1, Math.ceil(salesPage.total / salesPage.pageSize)) : 1;
    if (salesPage && salesFilters.page > totalPages) {
      setSalesFilters((current) => ({ ...current, page: totalPages }));
    }
  }, [salesFilters.page, salesPage?.pageSize, salesPage?.total]);

  function updatePayoutFilters(patch: Partial<ManualPayoutQuery>) {
    setPayoutFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function updateSalesFilters(patch: Partial<ManualSalesQuery>) {
    setSalesFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  if (!canWrite) {
    return <div className="page"><Alert tone="warning">你沒有管理報表資料的權限。</Alert></div>;
  }
  const activeQuery = kind === "payout" ? payoutsQuery : salesQuery;
  if (optionsQuery.isPending || scopesQuery.isPending || activeQuery.isPending) {
    return <div className="boot">載入報表管理中…</div>;
  }
  if (queryError) {
    return <div className="page"><Alert tone="danger">{queryError.message}</Alert></div>;
  }

  return (
    <div className="page fills manual-report-page">
      <PageHeader
        title="報表管理"
        actions={
          <div className="page-head-actions">
            <Button variant="secondary" icon="storefront" disabled={busy} onClick={() => setScopeDialog(true)}>管理據點</Button>
          </div>
        }
      />

      <Panel className="manual-report-panel grows">
        <div className="manual-report-toolbar">
          <div className="manual-report-tabs" role="tablist" aria-label="報表類型">
            <Button
              variant="chip"
              selected={kind === "payout"}
              role="tab"
              aria-selected={kind === "payout"}
              onClick={() => setKind("payout")}
            >
              <Icon name="payments" />
              出金
            </Button>
            <Button
              variant="chip"
              selected={kind === "sales"}
              role="tab"
              aria-selected={kind === "sales"}
              onClick={() => setKind("sales")}
            >
              <Icon name="report" />
              商品銷售
            </Button>
          </div>
          <div className="manual-report-actions">
            <Button variant="secondary" icon="attachment" disabled={busy} onClick={() => setImportDialog({ kind })}>匯入報表</Button>
            <Button
              icon="plus"
              className="add-action"
              disabled={!scopes.length || busy}
              onClick={() => setDialog({ kind })}
              aria-label={`新增${kind === "payout" ? "出金" : "商品銷售"}資料`}
            >
              <span>新增一列</span>
            </Button>
          </div>
        </div>

        {scopes.length === 0 ? <Alert tone="warning">尚未有可選的啟用據點。</Alert> : null}
        {kind === "payout" ? (
          <>
            <PayoutFilters filters={payoutFilters} scopes={managementScopes} onChange={updatePayoutFilters} />
            <PayoutTable
              rows={payoutPage?.rows ?? []}
              busy={busy}
              sortField={payoutFilters.sortField}
              sortDirection={payoutFilters.sortDirection}
              onSort={(sortField, sortDirection) => updatePayoutFilters({ sortField: sortField as ManualPayoutQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "payout", row })}
              onDelete={(row) => setDeleting({ kind: "payout", row })}
            />
            <ListFooter
              isFetching={payoutsQuery.isFetching}
              hasRows={Boolean(payoutPage?.rows.length)}
              total={payoutPage?.total ?? 0}
              hasFilters={hasPayoutFilters(payoutFilters)}
              emptyLabel="出金"
            />
            {payoutPage && payoutPage.total > 0 ? (
              <Pager
                page={payoutPage.page}
                pageSize={payoutPage.pageSize}
                pageSizes={PAGE_SIZES}
                totalPages={Math.max(1, Math.ceil(payoutPage.total / payoutPage.pageSize))}
                totalLabel={`共 ${payoutPage.total.toLocaleString("zh-TW")} 筆有效紀錄`}
                onPage={(page) => updatePayoutFilters({ page })}
                onPageSize={(pageSize) => updatePayoutFilters({ pageSize })}
              />
            ) : null}
          </>
        ) : (
          <>
            <SalesFilters filters={salesFilters} scopes={managementScopes} onChange={updateSalesFilters} />
            <SalesTable
              rows={salesPage?.rows ?? []}
              busy={busy}
              sortField={salesFilters.sortField}
              sortDirection={salesFilters.sortDirection}
              onSort={(sortField, sortDirection) => updateSalesFilters({ sortField: sortField as ManualSalesQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "sales", row })}
              onDelete={(row) => setDeleting({ kind: "sales", row })}
            />
            <ListFooter
              isFetching={salesQuery.isFetching}
              hasRows={Boolean(salesPage?.rows.length)}
              total={salesPage?.total ?? 0}
              hasFilters={hasSalesFilters(salesFilters)}
              emptyLabel="商品銷售"
            />
            {salesPage && salesPage.total > 0 ? (
              <Pager
                page={salesPage.page}
                pageSize={salesPage.pageSize}
                pageSizes={PAGE_SIZES}
                totalPages={Math.max(1, Math.ceil(salesPage.total / salesPage.pageSize))}
                totalLabel={`共 ${salesPage.total.toLocaleString("zh-TW")} 筆有效紀錄`}
                onPage={(page) => updateSalesFilters({ page })}
                onPageSize={(pageSize) => updateSalesFilters({ pageSize })}
              />
            ) : null}
          </>
        )}
      </Panel>

      {dialog ? (
        <ManualReportDialog
          key={`${dialog.kind}:${dialog.row?.id ?? "new"}`}
          state={dialog}
          scopes={dialogScopes}
          products={products}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {importDialog ? (
        <ReportImportDialog
          key={importDialog.kind}
          kind={importDialog.kind}
          scopes={scopes}
          products={products}
          onClose={() => setImportDialog(null)}
        />
      ) : null}

      {scopeDialog ? <ScopeManagementDialog scopes={managementScopes} onClose={() => setScopeDialog(false)} /> : null}

      {deleting ? (
        <ConfirmDialog
          title={`刪除這筆${deleting.kind === "payout" ? "出金" : "商品銷售"}資料？`}
          confirmLabel="刪除資料"
          pending={deleting.kind === "payout" ? deletePayout.isPending : deleteSales.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting.kind === "payout") {
              deletePayout.mutate(deleting.row, {
                onSuccess: () => {
                  toast.show("已刪除出金資料");
                  setDeleting(null);
                },
              });
            } else {
              deleteSales.mutate(deleting.row, {
                onSuccess: () => {
                  toast.show("已刪除商品銷售資料");
                  setDeleting(null);
                },
              });
            }
          }}
        >
          <p>
            {deleting.kind === "payout"
              ? `${deleting.row.scopeName} ${deleting.row.businessDate} 的出金資料將被刪除。`
              : `${deleting.row.scopeName} ${deleting.row.reportMonth} ${deleting.row.sku} 的商品銷售資料將被刪除。`}
          </p>
          <p className="muted">這筆資料會從報表管理與報表統計中移除。</p>
          <ErrorMessage error={deleting.kind === "payout" ? deletePayout.error : deleteSales.error} />
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function hasPayoutFilters(filters: ManualPayoutQuery): boolean {
  return Boolean(filters.search || filters.scopeId || filters.source !== "all" || filters.startDate || filters.endDate);
}

function hasSalesFilters(filters: ManualSalesQuery): boolean {
  return Boolean(filters.search || filters.scopeId || filters.source !== "all" || filters.startMonth || filters.endMonth);
}

function PayoutFilters({
  filters,
  scopes,
  onChange,
}: {
  filters: ManualPayoutQuery;
  scopes: ManualScopeOption[];
  onChange: (patch: Partial<ManualPayoutQuery>) => void;
}) {
  const active = hasPayoutFilters(filters);
  return (
    <form className="admin-form toolbar manual-report-filters" onSubmit={(event) => event.preventDefault()}>
      <FilterInput
        label="搜尋出金紀錄"
        className="search-input"
        type="search"
        placeholder="搜尋據點或日期"
        value={filters.search}
        onChange={(event) => onChange({ search: event.target.value })}
      />
      <FilterSelect
        label="出金據點"
        value={filters.scopeId}
        onChange={(event) => onChange({ scopeId: event.target.value })}
        options={[{ value: "", label: "全部據點" }, ...scopes.map((scope) => ({ value: scope.id, label: scope.name }))]}
      />
      <FilterSelect
        label="資料來源"
        value={filters.source}
        onChange={(event) => onChange({ source: event.target.value as ManualPayoutQuery["source"] })}
        options={[{ value: "all", label: "全部來源" }, { value: "imported", label: "系統匯入" }, { value: "manual", label: "人工修訂" }]}
      />
      <FilterInput
        label="出金開始日期"
        type="date"
        value={filters.startDate}
        onChange={(event) => onChange({ startDate: event.target.value })}
      />
      <FilterInput
        label="出金結束日期"
        type="date"
        value={filters.endDate}
        onChange={(event) => onChange({ endDate: event.target.value })}
      />
      {active ? <Button variant="link" onClick={() => onChange({ ...DEFAULT_PAYOUT_FILTERS })}>清除篩選</Button> : null}
    </form>
  );
}

function SalesFilters({
  filters,
  scopes,
  onChange,
}: {
  filters: ManualSalesQuery;
  scopes: ManualScopeOption[];
  onChange: (patch: Partial<ManualSalesQuery>) => void;
}) {
  const active = hasSalesFilters(filters);
  return (
    <form className="admin-form toolbar manual-report-filters" onSubmit={(event) => event.preventDefault()}>
      <FilterInput
        label="搜尋商品銷售紀錄"
        className="search-input"
        type="search"
        placeholder="搜尋據點、SKU、商品或分類"
        value={filters.search}
        onChange={(event) => onChange({ search: event.target.value })}
      />
      <FilterSelect
        label="商品銷售據點"
        value={filters.scopeId}
        onChange={(event) => onChange({ scopeId: event.target.value })}
        options={[{ value: "", label: "全部據點" }, ...scopes.map((scope) => ({ value: scope.id, label: scope.name }))]}
      />
      <FilterSelect
        label="資料來源"
        value={filters.source}
        onChange={(event) => onChange({ source: event.target.value as ManualSalesQuery["source"] })}
        options={[{ value: "all", label: "全部來源" }, { value: "imported", label: "系統匯入" }, { value: "manual", label: "人工修訂" }]}
      />
      <FilterInput
        label="商品銷售開始月份"
        type="month"
        value={filters.startMonth}
        onChange={(event) => onChange({ startMonth: event.target.value })}
      />
      <FilterInput
        label="商品銷售結束月份"
        type="month"
        value={filters.endMonth}
        onChange={(event) => onChange({ endMonth: event.target.value })}
      />
      {active ? <Button variant="link" onClick={() => onChange({ ...DEFAULT_SALES_FILTERS })}>清除篩選</Button> : null}
    </form>
  );
}

function ListFooter({
  isFetching,
  hasRows,
  total,
  hasFilters,
  emptyLabel,
}: {
  isFetching: boolean;
  hasRows: boolean;
  total: number;
  hasFilters: boolean;
  emptyLabel: string;
}) {
  if (isFetching) return <p className="muted table-note">更新資料中…</p>;
  if (hasRows || total > 0) return null;
  return <p className="manual-report-empty">{hasFilters ? "沒有符合篩選條件的紀錄。" : `目前沒有${emptyLabel}紀錄。`}</p>;
}

function PayoutTable({
  rows,
  busy,
  sortField,
  sortDirection,
  onSort,
  onEdit,
  onDelete,
}: {
  rows: ManualPayoutRow[];
  busy: boolean;
  sortField: ManualPayoutQuery["sortField"];
  sortDirection: ManualPayoutQuery["sortDirection"];
  onSort: (field: string, direction: "asc" | "desc") => void;
  onEdit: (row: ManualPayoutRow) => void;
  onDelete: (row: ManualPayoutRow) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table manual-report-table">
        <thead>
          <tr>
            <SortableHeader label="據點" field="scope" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="日期" field="businessDate" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="出金金額" field="payoutAmount" active={sortField} direction={sortDirection} onSort={onSort} className="numeric" />
            <th>最後更新</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td data-label="據點">{row.scopeName}</td>
              <td data-label="日期" className="whitespace-nowrap">{row.businessDate}</td>
              <td data-label="出金金額" className="numeric">{formatCurrency(row.payoutAmount)}</td>
              <td data-label="最後更新">
                <span>{row.updatedByEmail}</span>
                <small className="cell-sub">{formatTime(row.updatedAt)}</small>
              </td>
              <td data-label="操作">
                <div className="row-actions">
                  <Button
                    variant="icon"
                    icon="edit"
                    disabled={busy}
                    onClick={() => onEdit(row)}
                    title={`編輯 ${row.businessDate} 出金資料`}
                    aria-label={`編輯 ${row.businessDate} 出金資料`}
                  />
                  <Button
                    variant="icon"
                    className="danger"
                    icon="trash"
                    disabled={busy}
                    onClick={() => onDelete(row)}
                    title={`刪除 ${row.businessDate} 出金資料`}
                    aria-label={`刪除 ${row.businessDate} 出金資料`}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SalesTable({
  rows,
  busy,
  sortField,
  sortDirection,
  onSort,
  onEdit,
  onDelete,
}: {
  rows: ManualSalesRow[];
  busy: boolean;
  sortField: ManualSalesQuery["sortField"];
  sortDirection: ManualSalesQuery["sortDirection"];
  onSort: (field: string, direction: "asc" | "desc") => void;
  onEdit: (row: ManualSalesRow) => void;
  onDelete: (row: ManualSalesRow) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table manual-report-table manual-sales-table">
        <thead>
          <tr>
            <SortableHeader label="據點" field="scope" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="月份" field="reportMonth" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="SKU" field="sku" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="商品" field="productName" active={sortField} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="數量" field="netQuantity" active={sortField} direction={sortDirection} onSort={onSort} className="numeric" />
            <SortableHeader label="銷售金額" field="salesAmount" active={sortField} direction={sortDirection} onSort={onSort} className="numeric" />
            <th>最後更新</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td data-label="據點">{row.scopeName}</td>
              <td data-label="月份" className="whitespace-nowrap">{row.reportMonth}</td>
              <td data-label="SKU">
                <code>{row.sku}</code>
              </td>
              <td data-label="商品">
                <span>{row.productName}</span>
                <small className="cell-sub">{row.category}</small>
              </td>
              <td data-label="數量" className="numeric">
                <span>{row.netQuantity.toLocaleString("zh-TW")}</span>
                <small className="cell-sub">銷售 {row.grossQuantity.toLocaleString("zh-TW")} · 退貨 {row.returnQuantity.toLocaleString("zh-TW")}</small>
              </td>
              <td data-label="銷售金額" className="numeric">{formatCurrency(row.salesAmount)}</td>
              <td data-label="最後更新">
                <span>{row.updatedByEmail}</span>
                <small className="cell-sub">{formatTime(row.updatedAt)}</small>
              </td>
              <td data-label="操作">
                <div className="row-actions">
                  <Button
                    variant="icon"
                    icon="edit"
                    disabled={busy}
                    onClick={() => onEdit(row)}
                    title={`編輯 ${row.sku} 商品銷售資料`}
                    aria-label={`編輯 ${row.sku} 商品銷售資料`}
                  />
                  <Button
                    variant="icon"
                    className="danger"
                    icon="trash"
                    disabled={busy}
                    onClick={() => onDelete(row)}
                    title={`刪除 ${row.sku} 商品銷售資料`}
                    aria-label={`刪除 ${row.sku} 商品銷售資料`}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
