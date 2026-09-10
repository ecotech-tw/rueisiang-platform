import { Combobox } from "@base-ui/react/combobox";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateManualPayout,
  useCreateManualSales,
  useDeleteManualPayouts,
  useDeleteManualSalesRecords,
  useImportManualPayout,
  useImportManualSales,
  useManualPayouts,
  useManualReportOptions,
  useManualSales,
  useUpdateManualPayout,
  useUpdateManualSales,
  type ManualPayoutInput,
  type ManualPayoutQuery,
  type ManualPayoutRow,
  type ManualProductOption,
  type ManualProductCategoryOption,
  type ManualReportKind,
  type ManualSalesInput,
  type ManualSalesQuery,
  type ManualSalesRow,
  type ManualScopeOption,
  type ManualSkuSource,
} from "./manual-reports-api.js";
import {
  parseStandardImportFile,
  type StandardImportPreview,
  type StandardPayoutImportRow,
  type StandardSalesImportRow,
} from "./manual-report-import.js";

type DialogState =
  | { kind: "payout"; row?: ManualPayoutRow }
  | { kind: "sales"; row?: ManualSalesRow };

type DeletingState =
  | { kind: "payout"; rows: ManualPayoutRow[] }
  | { kind: "sales"; rows: ManualSalesRow[] };

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

// 舊人工報表可能保留已刪除的分類名稱；這個值只存在表單狀態，不會送到 API。
const LEGACY_CATEGORY_OPTION = "__legacy_category__";

function ManualCombo<T>({
  items,
  value,
  onChange,
  placeholder,
  emptyLabel,
  itemToStringLabel,
  renderItem,
  disabled = false,
}: {
  items: T[];
  value: T | null;
  onChange: (item: T | null) => void;
  placeholder: string;
  emptyLabel: string;
  itemToStringLabel: (item: T | null) => string;
  renderItem: (item: T) => React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Combobox.Root items={items} value={value} onValueChange={onChange} itemToStringLabel={itemToStringLabel} autoHighlight disabled={disabled}>
      <Combobox.InputGroup className="combobox-group">
        <Combobox.Input className="combobox-input" placeholder={placeholder} />
        <Combobox.Clear className="combobox-clear" aria-label="清除選擇"><Icon name="close" /></Combobox.Clear>
        <Combobox.Trigger className="combobox-trigger" aria-label="開啟選單"><Icon name="chevronDown" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>{emptyLabel}</Combobox.Empty><Combobox.List>{(item: T) => <Combobox.Item key={itemToStringLabel(item)} value={item} className="combobox-item">{renderItem(item)}<Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
    </Combobox.Root>
  );
}

function ErrorMessage({ error }: { error: Error | null | undefined }) {
  return error ? <Alert tone="danger">{error.message}</Alert> : null;
}

function ManualReportDialog({
  state,
  scopes,
  products,
  categories,
  onClose,
}: {
  state: DialogState;
  scopes: ManualScopeOption[];
  products: ManualProductOption[];
  categories: ManualProductCategoryOption[];
  onClose: () => void;
}) {
  const createPayout = useCreateManualPayout();
  const updatePayout = useUpdateManualPayout();
  const createSales = useCreateManualSales();
  const updateSales = useUpdateManualSales();
  const initialSkuSource: ManualSkuSource = state.kind !== "sales"
    ? "cyberbiz"
    : state.row?.skuSource ?? (state.row && products.some((product) => product.sku === state.row?.sku) ? "cyberbiz" : "custom");
  const initialCategoryName = state.kind === "sales" ? state.row?.category?.trim() || "未分類" : "未分類";
  const initialCategoryOption = initialSkuSource === "custom"
    ? categories.find((option) => option.name === initialCategoryName)
    : undefined;
  const legacyCategory = initialSkuSource === "custom"
    && initialCategoryName !== "未分類"
    && !initialCategoryOption
    ? initialCategoryName
    : null;
  const [scopeId, setScopeId] = useState(state.row?.scopeId ?? scopes[0]?.id ?? "");
  const [businessDate, setBusinessDate] = useState(state.kind === "payout" ? state.row?.businessDate ?? "" : "");
  const [payoutAmount, setPayoutAmount] = useState(state.kind === "payout" ? String(state.row?.payoutAmount ?? "") : "");
  const [reportMonth, setReportMonth] = useState(state.kind === "sales" ? state.row?.reportMonth ?? "" : "");
  const [skuSource, setSkuSource] = useState<ManualSkuSource>(initialSkuSource);
  const [sku, setSku] = useState(state.kind === "sales" ? state.row?.sku ?? "" : "");
  const [productName, setProductName] = useState(state.kind === "sales" ? state.row?.productName ?? "" : "");
  const [category, setCategory] = useState(initialCategoryName);
  const [categoryId, setCategoryId] = useState(legacyCategory ? LEGACY_CATEGORY_OPTION : initialCategoryOption?.id ?? "");
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
  const categoryOptions = useMemo(() => [
    { id: "", name: "未分類", color: "slate" },
    ...(legacyCategory ? [{ id: LEGACY_CATEGORY_OPTION, name: `${legacyCategory}（已不在分類清單）`, color: "slate" }] : []),
    ...categories,
  ], [categories, legacyCategory]);
  const selectedCategory = categoryOptions.find((option) => option.id === categoryId) ?? null;
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
      const categoryName = category.trim() || "未分類";
      const input: ManualSalesInput = {
        scopeId,
        reportMonth,
        skuSource,
        sku,
        ...(skuSource === "custom"
          ? {
            productName: productName.trim(),
            ...(categoryId === LEGACY_CATEGORY_OPTION
              ? { category: categoryName }
              : { categoryId: categoryId || null, category: categoryName }),
          }
          : {}),
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
                  setCategoryId("");
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
                <div className="field">
                  <span>CYBERBIZ SKU<b aria-hidden="true">必填</b></span>
                  <ManualCombo
                    items={productOptions}
                    value={productOptions.find((product) => product.sku === sku) ?? null}
                    onChange={(product) => {
                      const nextSku = product?.sku ?? "";
                      setSku(nextSku);
                      setProductName(product?.name ?? nextSku);
                    }}
                    placeholder="搜尋 SKU 或商品名稱"
                    emptyLabel="找不到 CYBERBIZ 商品"
                    itemToStringLabel={(product) => product ? `${product.sku} ${product.name}` : ""}
                    renderItem={(product) => <><strong>{product.sku}</strong><span>{product.name}{product.published ? "" : "（已下架）"}</span></>}
                    disabled={pending}
                  />
                </div>
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
                <div className="field">
                  <span>商品分類</span>
                  <ManualCombo
                    items={categoryOptions}
                    value={selectedCategory}
                    onChange={(option) => {
                      const nextCategoryId = option?.id ?? "";
                      setCategoryId(nextCategoryId);
                      setCategory(nextCategoryId === LEGACY_CATEGORY_OPTION ? legacyCategory ?? "未分類" : option?.name ?? "未分類");
                    }}
                    placeholder="搜尋或選擇分類"
                    emptyLabel="找不到分類"
                    itemToStringLabel={(option) => option?.name ?? ""}
                    renderItem={(option) => <span>{option.name}</span>}
                    disabled={pending}
                  />
                </div>
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

type ImportEditState =
  | { kind: "payout"; row: StandardPayoutImportRow }
  | { kind: "sales"; row: StandardSalesImportRow };

function importSalesTotals(rows: StandardSalesImportRow[]) {
  return rows.reduce((totals, row) => ({
    grossQuantity: totals.grossQuantity + row.grossQuantity,
    returnQuantity: totals.returnQuantity + row.returnQuantity,
    netQuantity: totals.netQuantity + row.netQuantity,
    salesAmount: totals.salesAmount + row.salesAmount,
  }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 });
}

function isValidImportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function ImportRecordDialog({
  state,
  onClose,
  onSave,
}: {
  state: ImportEditState;
  onClose: () => void;
  onSave: (state: ImportEditState) => void;
}) {
  const [businessDate, setBusinessDate] = useState(state.kind === "payout" ? state.row.businessDate : "");
  const [payoutAmount, setPayoutAmount] = useState(state.kind === "payout" ? String(state.row.payoutAmount) : "");
  const [reportMonth, setReportMonth] = useState(state.kind === "sales" ? state.row.reportMonth : "");
  const [sku, setSku] = useState(state.kind === "sales" ? state.row.sku : "");
  const [productName, setProductName] = useState(state.kind === "sales" ? state.row.productName : "");
  const [category, setCategory] = useState(state.kind === "sales" ? state.row.category : "");
  const [grossQuantity, setGrossQuantity] = useState(state.kind === "sales" ? String(state.row.grossQuantity) : "");
  const [returnQuantity, setReturnQuantity] = useState(state.kind === "sales" ? String(state.row.returnQuantity) : "");
  const [netQuantity, setNetQuantity] = useState(state.kind === "sales" ? String(state.row.netQuantity) : "");
  const [salesAmount, setSalesAmount] = useState(state.kind === "sales" ? String(state.row.salesAmount) : "");

  const payoutValue = parseSafeInteger(payoutAmount);
  const salesValues = {
    grossQuantity: parseSafeInteger(grossQuantity),
    returnQuantity: parseSafeInteger(returnQuantity),
    netQuantity: parseSafeInteger(netQuantity),
    salesAmount: parseSafeInteger(salesAmount),
  };
  const valid = state.kind === "payout"
    ? isValidImportDate(businessDate) && payoutValue !== null
    : Boolean(
      /^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)
      && sku.trim()
      && Object.values(salesValues).every((value) => value !== null),
    );

  function submit() {
    if (!valid) return;
    if (state.kind === "payout" && payoutValue !== null) {
      onSave({ kind: "payout", row: { ...state.row, businessDate, payoutAmount: payoutValue } });
      return;
    }
    if (state.kind === "sales") {
      onSave({
        kind: "sales",
        row: {
          ...state.row,
          reportMonth,
          sku: sku.trim(),
          productName: productName.trim() || sku.trim(),
          category: category.trim() || "未分類",
          grossQuantity: salesValues.grossQuantity ?? 0,
          returnQuantity: salesValues.returnQuantity ?? 0,
          netQuantity: salesValues.netQuantity ?? 0,
          salesAmount: salesValues.salesAmount ?? 0,
        },
      });
    }
  }

  return (
    <Dialog
      title={`編輯匯入資料（第 ${state.row.sourceRow} 列）`}
      className="manual-report-dialog manual-report-import-row-dialog"
      onClose={onClose}
      formProps={{ onSubmit: (event) => { event.preventDefault(); submit(); } }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!valid}>儲存這列</Button>
        </>
      }
    >
      <div className="manual-report-form">
        {state.kind === "payout" ? (
          <div className="field-grid">
            <TextField
              label="出金日期"
              required
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
            />
            <TextField
              label="出金金額"
              required
              type="number"
              step="1"
              inputMode="numeric"
              value={payoutAmount}
              onChange={(event) => setPayoutAmount(event.target.value)}
            />
          </div>
        ) : (
          <>
            <div className="field-grid">
              <TextField label="報表月份" required type="month" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} />
              <TextField label="SKU" required value={sku} onChange={(event) => setSku(event.target.value)} />
              <TextField label="商品名稱" value={productName} onChange={(event) => setProductName(event.target.value)} />
              <TextField label="類別" value={category} onChange={(event) => setCategory(event.target.value)} />
            </div>
            <div className="field-grid trio">
              <TextField label="銷售數量" required type="number" step="1" inputMode="numeric" value={grossQuantity} onChange={(event) => setGrossQuantity(event.target.value)} />
              <TextField label="退回數量" required type="number" step="1" inputMode="numeric" value={returnQuantity} onChange={(event) => setReturnQuantity(event.target.value)} />
              <TextField label="淨銷售數量" required type="number" step="1" inputMode="numeric" value={netQuantity} onChange={(event) => setNetQuantity(event.target.value)} />
            </div>
            <TextField label="售額總計" required type="number" step="1" inputMode="numeric" value={salesAmount} onChange={(event) => setSalesAmount(event.target.value)} />
          </>
        )}
      </div>
    </Dialog>
  );
}

function StandardReportImportDialog({
  kind,
  scopes,
  onClose,
}: {
  kind: ManualReportKind;
  scopes: ManualScopeOption[];
  onClose: () => void;
}) {
  const importPayout = useImportManualPayout();
  const importSales = useImportManualSales();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<StandardImportPreview | null>(null);
  const [editing, setEditing] = useState<ImportEditState | null>(null);
  const [parseError, setParseError] = useState("");
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");
  const [scopeName, setScopeName] = useState("");

  const selectedScopeName = scopeId ? scopes.find((scope) => scope.id === scopeId)?.name ?? "" : scopeName.trim();
  const pending = importPayout.isPending || importSales.isPending;
  const error = parseError || importPayout.error?.message || importSales.error?.message || "";
  const rowCount = preview && preview.kind === kind ? preview.rows.length : 0;
  const valid = Boolean(selectedScopeName && rowCount);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setPreview(null);
    setEditing(null);
    setParseError("");
    try {
      setPreview(await parseStandardImportFile(file, kind));
    } catch (parseFailure) {
      setParseError(parseFailure instanceof Error ? parseFailure.message : "讀不開這個檔案。請下載範例檔案確認欄位格式。");
    }
  }

  function saveEditedRow(next: ImportEditState) {
    setPreview((current) => {
      if (!current || current.kind !== next.kind) return current;
      if (current.kind === "payout" && next.kind === "payout") {
        const nextRows = current.rows.map((row) => row.sourceRow === next.row.sourceRow ? next.row : row);
        const dates = nextRows.map((row) => row.businessDate).sort();
        return {
          ...current,
          rows: nextRows,
          total: nextRows.reduce((total, row) => total + row.payoutAmount, 0),
          coverageStart: dates[0] ?? "",
          coverageEnd: dates.at(-1) ?? "",
        };
      }
      if (current.kind === "sales" && next.kind === "sales") {
        const nextRows = current.rows.map((row) => row.sourceRow === next.row.sourceRow ? next.row : row);
        return {
          ...current,
          rows: nextRows,
          reportMonths: [...new Set(nextRows.map((row) => row.reportMonth))].sort(),
          totals: importSalesTotals(nextRows),
        };
      }
      return current;
    });
    setEditing(null);
  }

  function submit() {
    if (!valid || !selectedScopeName || !preview || preview.kind !== kind) return;
    if (kind === "payout" && preview.kind === "payout") {
      importPayout.mutate({
        format: "standard",
        scopeName: selectedScopeName,
        ...(scopeId ? { scopeId } : {}),
        rows: preview.rows.map(({ businessDate, payoutAmount }) => ({ businessDate, payoutAmount })),
      }, {
        onSuccess: (result) => {
          toast.show(`已匯入${result.scopeName} ${result.dayCount} 天，合計 ${result.total.toLocaleString("zh-TW")}`);
          if (fileInputRef.current) fileInputRef.current.value = "";
          onClose();
        },
      });
      return;
    }
    if (kind !== "sales" || preview.kind !== "sales") return;
    importSales.mutate({
      format: "standard",
      scopeName: selectedScopeName,
      ...(scopeId ? { scopeId } : {}),
      rows: preview.rows.map(({ reportMonth, sku, productName, category, grossQuantity, returnQuantity, netQuantity, salesAmount }) => ({
        reportMonth,
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
        const months = result.reportMonths?.length ? result.reportMonths.join("、") : result.reportMonth ?? "";
        toast.show(`已匯入${result.scopeName} ${months} ${result.rowCount} 筆商品銷售資料`);
        if (fileInputRef.current) fileInputRef.current.value = "";
        onClose();
      },
    });
  }

  return (
    <>
      <Dialog
        title={`匯入${kind === "payout" ? "出金" : "商品銷售"}報表`}
        className="manual-report-import-dialog"
        backdropClassName="manual-report-import-backdrop"
        bodyClassName="manual-report-import-body"
        onClose={onClose}
        closeDisabled={pending}
        formProps={{ onSubmit: (event) => { event.preventDefault(); submit(); } }}
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
              options={[{ label: scopes.length ? "新增據點…" : "輸入新據點", value: "" }, ...scopes.map((scope) => ({ label: scope.name, value: scope.id }))]}
              disabled={pending}
            />
            {!scopeId ? <TextField label="新據點名稱" required value={scopeName} onChange={(event) => setScopeName(event.target.value)} disabled={pending} /> : <div />}
          </div>

          <div className="manual-report-import-format-note">
            <p>請使用指定欄位順序的 CSV 或 XLSX 檔案；匯入前可逐筆編輯所有欄位。</p>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                const link = document.createElement("a");
                link.href = kind === "payout" ? "/templates/manual-payout.csv" : "/templates/manual-sales.csv";
                link.download = kind === "payout" ? "manual-payout.csv" : "manual-sales.csv";
                link.click();
              }}
            >下載範例檔案</Button>
          </div>

          <label className="manual-report-file-picker">
            <span className="field-label">標準格式檔案</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => void pickFile(event.target.files?.[0])}
              disabled={pending}
            />
            {fileName ? <span className="form-hint">{fileName}</span> : null}
          </label>

          {error ? <Alert tone="danger">{error}</Alert> : null}
          {preview?.kind === "payout" ? (
            <section className="manual-report-import-preview">
              <div className="manual-report-import-preview-head">
                <div>
                  <h3>預覽</h3>
                  <p className="muted">{preview.coverageStart} ~ {preview.coverageEnd}，共 {preview.rows.length} 列，合計 {formatCurrency(preview.total)}</p>
                </div>
                <span className="form-hint">確認後才會寫入</span>
              </div>
              <div className="table-scroll manual-report-import-table-scroll">
                <table className="data-table">
                  <thead><tr><th>來源列</th><th>日期</th><th className="numeric">金額</th><th /></tr></thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.sourceRow}>
                        <td>{row.sourceRow}</td>
                        <td>{row.businessDate}</td>
                        <td className="numeric">{formatCurrency(row.payoutAmount)}</td>
                        <td><Button variant="icon" icon="edit" disabled={pending} onClick={() => setEditing({ kind: "payout", row })} title={`編輯第 ${row.sourceRow} 列`} aria-label={`編輯第 ${row.sourceRow} 列`} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {preview?.kind === "sales" ? (
            <section className="manual-report-import-preview">
              <div className="manual-report-import-preview-head">
                <div>
                  <h3>預覽</h3>
                  <p className="muted">月份：{preview.reportMonths.join("、")}，共 {preview.rows.length} 列</p>
                </div>
                <span className="form-hint">確認後才會寫入</span>
              </div>
              <div className="table-scroll manual-report-import-table-scroll">
                <table className="data-table manual-sales-table">
                  <thead><tr><th>來源列</th><th>月份</th><th>SKU</th><th>商品名稱</th><th>類別</th><th className="numeric">銷售數量</th><th className="numeric">退回數量</th><th className="numeric">淨銷售數量</th><th className="numeric">售額總計</th><th /></tr></thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.sourceRow}>
                        <td>{row.sourceRow}</td>
                        <td>{row.reportMonth}</td>
                        <td><code>{row.sku}</code></td>
                        <td>{row.productName || "—"}</td>
                        <td>{row.category}</td>
                        <td className="numeric">{row.grossQuantity.toLocaleString("zh-TW")}</td>
                        <td className="numeric">{row.returnQuantity.toLocaleString("zh-TW")}</td>
                        <td className="numeric">{row.netQuantity.toLocaleString("zh-TW")}</td>
                        <td className="numeric">{formatCurrency(row.salesAmount)}</td>
                        <td><Button variant="icon" icon="edit" disabled={pending} onClick={() => setEditing({ kind: "sales", row })} title={`編輯第 ${row.sourceRow} 列`} aria-label={`編輯第 ${row.sourceRow} 列`} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </Dialog>
      {editing ? <ImportRecordDialog state={editing} onClose={() => setEditing(null)} onSave={saveEditedRow} /> : null}
    </>
  );
}

export function ManualReports() {
  usePageTitle("報表管理");
  const { permissions } = useSession();
  const canWrite = permissions.has("reports:cyberbiz:write");
  const optionsQuery = useManualReportOptions(canWrite);
  const [payoutFilters, setPayoutFilters] = useState<ManualPayoutQuery>(DEFAULT_PAYOUT_FILTERS);
  const [salesFilters, setSalesFilters] = useState<ManualSalesQuery>(DEFAULT_SALES_FILTERS);
  const payoutsQuery = useManualPayouts(payoutFilters, canWrite);
  const salesQuery = useManualSales(salesFilters, canWrite);
  const deletePayouts = useDeleteManualPayouts();
  const deleteSalesRecords = useDeleteManualSalesRecords();
  const toast = useToast();
  const [kind, setKind] = useState<ManualReportKind>("sales");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);
  const [selectedPayoutIds, setSelectedPayoutIds] = useState<Set<string>>(() => new Set());
  const [selectedSalesIds, setSelectedSalesIds] = useState<Set<string>>(() => new Set());

  const scopes = optionsQuery.data?.scopes ?? [];
  const products = optionsQuery.data?.products ?? [];
  const categories = optionsQuery.data?.categories ?? [];
  const payoutPage = payoutsQuery.data;
  const salesPage = salesQuery.data;
  const queryError = optionsQuery.error ?? (kind === "payout" ? payoutsQuery.error : salesQuery.error);
  const payoutRows = payoutPage?.rows ?? [];
  const salesRows = salesPage?.rows ?? [];
  const busy = deletePayouts.isPending || deleteSalesRecords.isPending;
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
    setSelectedPayoutIds(new Set());
    setPayoutFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function updateSalesFilters(patch: Partial<ManualSalesQuery>) {
    setSelectedSalesIds(new Set());
    setSalesFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function togglePayout(row: ManualPayoutRow) {
    setSelectedPayoutIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function toggleSales(row: ManualSalesRow) {
    setSelectedSalesIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }

  function toggleAllPayouts(checked: boolean) {
    setSelectedPayoutIds(checked ? new Set(payoutRows.map((row) => row.id)) : new Set());
  }

  function toggleAllSales(checked: boolean) {
    setSelectedSalesIds(checked ? new Set(salesRows.map((row) => row.id)) : new Set());
  }

  const selectedPayoutRows = payoutRows.filter((row) => selectedPayoutIds.has(row.id));
  const selectedSalesRows = salesRows.filter((row) => selectedSalesIds.has(row.id));
  const allPayoutsSelected = payoutRows.length > 0 && payoutRows.every((row) => selectedPayoutIds.has(row.id));
  const allSalesSelected = salesRows.length > 0 && salesRows.every((row) => selectedSalesIds.has(row.id));

  if (!canWrite) {
    return <div className="page"><Alert tone="warning">你沒有管理報表資料的權限。</Alert></div>;
  }
  const activeQuery = kind === "payout" ? payoutsQuery : salesQuery;
  if (optionsQuery.isPending || activeQuery.isPending) {
    return <div className="boot">載入報表管理中…</div>;
  }
  if (queryError) {
    return <div className="page"><Alert tone="danger">{queryError.message}</Alert></div>;
  }

  return (
    <div className="page fills manual-report-page">
      <PageHeader title="報表管理" />

      <Panel
        className="manual-report-panel grows"
        title={kind === "payout" ? "每日出金紀錄" : "每月商品銷售紀錄"}
        description={kind === "payout" ? "依每日出金日期查看、篩選與修訂紀錄。" : "依報表月份查看、篩選與修訂商品銷售紀錄。"}
        actions={(
          <div className="manual-report-toolbar">
            <div className="manual-report-tabs" role="tablist" aria-label="報表類型">
              <Button
                variant="chip"
                selected={kind === "payout"}
                role="tab"
                aria-selected={kind === "payout"}
                onClick={() => { setKind("payout"); setSelectedPayoutIds(new Set()); setSelectedSalesIds(new Set()); }}
              >
                <Icon name="payments" />
                每日出金
              </Button>
              <Button
                variant="chip"
                selected={kind === "sales"}
                role="tab"
                aria-selected={kind === "sales"}
                onClick={() => { setKind("sales"); setSelectedPayoutIds(new Set()); setSelectedSalesIds(new Set()); }}
              >
                <Icon name="report" />
                每月商品銷售
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
        )}
      >
        {scopes.length === 0 ? <Alert tone="warning">尚未有可選的啟用據點。</Alert> : null}
        {kind === "payout" ? (
          <>
            <PayoutFilters filters={payoutFilters} scopes={scopes} onChange={updatePayoutFilters} />
            <PayoutTable
              rows={payoutRows}
              busy={busy}
              selectedIds={selectedPayoutIds}
              selectedCount={selectedPayoutRows.length}
              onToggle={togglePayout}
              allSelected={allPayoutsSelected}
              onToggleAll={toggleAllPayouts}
              onDeleteSelected={() => setDeleting({ kind: "payout", rows: selectedPayoutRows })}
              sortField={payoutFilters.sortField}
              sortDirection={payoutFilters.sortDirection}
              onSort={(sortField, sortDirection) => updatePayoutFilters({ sortField: sortField as ManualPayoutQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "payout", row })}
              onDelete={(row) => setDeleting({ kind: "payout", rows: [row] })}
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
            <SalesFilters filters={salesFilters} scopes={scopes} onChange={updateSalesFilters} />
            <SalesTable
              rows={salesRows}
              busy={busy}
              selectedIds={selectedSalesIds}
              selectedCount={selectedSalesRows.length}
              onToggle={toggleSales}
              allSelected={allSalesSelected}
              onToggleAll={toggleAllSales}
              onDeleteSelected={() => setDeleting({ kind: "sales", rows: selectedSalesRows })}
              sortField={salesFilters.sortField}
              sortDirection={salesFilters.sortDirection}
              onSort={(sortField, sortDirection) => updateSalesFilters({ sortField: sortField as ManualSalesQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "sales", row })}
              onDelete={(row) => setDeleting({ kind: "sales", rows: [row] })}
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
          categories={categories}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {importDialog ? (
        <StandardReportImportDialog
          key={importDialog.kind}
          kind={importDialog.kind}
          scopes={scopes}
          onClose={() => setImportDialog(null)}
        />
      ) : null}


      {deleting ? (
        <ConfirmDialog
          title={`刪除選取的${deleting.kind === "payout" ? "出金" : "商品銷售"}資料？`}
          confirmLabel="刪除資料"
          pending={deleting.kind === "payout" ? deletePayouts.isPending : deleteSalesRecords.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting.kind === "payout") {
              deletePayouts.mutate(deleting.rows, {
                onSuccess: (result) => {
                  toast.show(`已刪除 ${result.deletedCount} 筆出金資料`);
                  setDeleting(null);
                  setSelectedPayoutIds(new Set());
                },
              });
            } else {
              deleteSalesRecords.mutate(deleting.rows, {
                onSuccess: (result) => {
                  toast.show(`已刪除 ${result.deletedCount} 筆商品銷售資料`);
                  setDeleting(null);
                  setSelectedSalesIds(new Set());
                },
              });
            }
          }}
        >
          <p>
            將刪除 {deleting.rows.length} 筆{deleting.kind === "payout" ? "出金" : "商品銷售"}資料。
          </p>
          <p className="muted">資料會從報表管理與報表統計中移除；若刪除的是人工覆寫，原本的匯入資料會恢復顯示。</p>
          <ErrorMessage error={deleting.kind === "payout" ? deletePayouts.error : deleteSalesRecords.error} />
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
      <SearchFilterInput
        label="搜尋出金紀錄"
        placeholder="搜尋據點或日期"
        value={filters.search}
        onSearch={(search) => onChange({ search })}
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
      <SearchFilterInput
        label="搜尋商品銷售紀錄"
        placeholder="搜尋據點、SKU、商品或分類"
        value={filters.search}
        onSearch={(search) => onChange({ search })}
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

function TableSelectAllCheckbox({
  allSelected,
  someSelected,
  busy,
  onToggleAll,
  ariaLabel,
}: {
  allSelected: boolean;
  someSelected: boolean;
  busy: boolean;
  onToggleAll: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <input
      ref={checkboxRef}
      className="table-checkbox"
      type="checkbox"
      checked={allSelected}
      onChange={(event) => onToggleAll(event.target.checked)}
      disabled={busy}
      aria-label={ariaLabel}
    />
  );
}

function MobileTableSelectAll({
  allSelected,
  someSelected,
  busy,
  onToggleAll,
  ariaLabel,
}: {
  allSelected: boolean;
  someSelected: boolean;
  busy: boolean;
  onToggleAll: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <div className="manual-report-mobile-select-all">
      <label className="table-select-all">
        <TableSelectAllCheckbox
          allSelected={allSelected}
          someSelected={someSelected}
          busy={busy}
          onToggleAll={onToggleAll}
          ariaLabel={ariaLabel}
        />
        <span>{allSelected ? "取消全選本頁" : "全選本頁"}</span>
      </label>
    </div>
  );
}

function SelectionActions({ selectedCount, busy, onDelete }: { selectedCount: number; busy: boolean; onDelete: () => void }) {
  return (
    <div className="manual-report-selection-actions">
      <span className="manual-report-selection-count" aria-live="polite">已選取 {selectedCount} 筆</span>
      <Button
        variant="danger"
        icon="trash"
        disabled={busy}
        onClick={onDelete}
      >
        刪除選取資料
      </Button>
    </div>
  );
}

function PayoutTable({
  rows,
  busy,
  selectedIds,
  selectedCount,
  onToggle,
  allSelected,
  onToggleAll,
  onDeleteSelected,
  sortField,
  sortDirection,
  onSort,
  onEdit,
  onDelete,
}: {
  rows: ManualPayoutRow[];
  busy: boolean;
  selectedIds: Set<string>;
  selectedCount: number;
  onToggle: (row: ManualPayoutRow) => void;
  allSelected: boolean;
  onToggleAll: (checked: boolean) => void;
  onDeleteSelected: () => void;
  sortField: ManualPayoutQuery["sortField"];
  sortDirection: ManualPayoutQuery["sortDirection"];
  onSort: (field: string, direction: "asc" | "desc") => void;
  onEdit: (row: ManualPayoutRow) => void;
  onDelete: (row: ManualPayoutRow) => void;
}) {
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <div className="manual-report-table-region">
      <div className="table-scroll">
        <MobileTableSelectAll
          allSelected={allSelected}
          someSelected={someSelected}
          busy={busy || !rows.length}
          onToggleAll={onToggleAll}
          ariaLabel={allSelected ? "取消全選本頁出金紀錄" : "全選本頁出金紀錄"}
        />
        <table className="data-table manual-report-table">
          <thead>
            <tr>
              <th>
                <TableSelectAllCheckbox
                  allSelected={allSelected}
                  someSelected={someSelected}
                  busy={busy || !rows.length}
                  onToggleAll={onToggleAll}
                  ariaLabel={allSelected ? "取消全選本頁出金紀錄" : "全選本頁出金紀錄"}
                />
              </th>
              <SortableHeader label="據點" field="scope" active={sortField} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="日期" field="businessDate" active={sortField} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="出金金額" field="payoutAmount" active={sortField} direction={sortDirection} onSort={onSort} className="numeric" />
              <th>最後更新</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={selectedIds.has(row.id) ? "selected" : undefined}>
                <td data-label="選取">
                  <input
                    className="table-checkbox"
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => onToggle(row)}
                    disabled={busy}
                    aria-label={`選取 ${row.businessDate} 出金資料`}
                  />
                </td>
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
      {selectedCount > 0 ? <SelectionActions selectedCount={selectedCount} busy={busy} onDelete={onDeleteSelected} /> : null}
    </div>
  );
}

function SalesTable({
  rows,
  busy,
  selectedIds,
  selectedCount,
  onToggle,
  allSelected,
  onToggleAll,
  onDeleteSelected,
  sortField,
  sortDirection,
  onSort,
  onEdit,
  onDelete,
}: {
  rows: ManualSalesRow[];
  busy: boolean;
  selectedIds: Set<string>;
  selectedCount: number;
  onToggle: (row: ManualSalesRow) => void;
  allSelected: boolean;
  onToggleAll: (checked: boolean) => void;
  onDeleteSelected: () => void;
  sortField: ManualSalesQuery["sortField"];
  sortDirection: ManualSalesQuery["sortDirection"];
  onSort: (field: string, direction: "asc" | "desc") => void;
  onEdit: (row: ManualSalesRow) => void;
  onDelete: (row: ManualSalesRow) => void;
}) {
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <div className="manual-report-table-region">
      <div className="table-scroll">
        <MobileTableSelectAll
          allSelected={allSelected}
          someSelected={someSelected}
          busy={busy || !rows.length}
          onToggleAll={onToggleAll}
          ariaLabel={allSelected ? "取消全選本頁商品銷售紀錄" : "全選本頁商品銷售紀錄"}
        />
        <table className="data-table manual-report-table manual-sales-table">
          <thead>
            <tr>
              <th>
                <TableSelectAllCheckbox
                  allSelected={allSelected}
                  someSelected={someSelected}
                  busy={busy || !rows.length}
                  onToggleAll={onToggleAll}
                  ariaLabel={allSelected ? "取消全選本頁商品銷售紀錄" : "全選本頁商品銷售紀錄"}
                />
              </th>
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
              <tr key={row.id} className={selectedIds.has(row.id) ? "selected" : undefined}>
                <td data-label="選取">
                  <input
                    className="table-checkbox"
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => onToggle(row)}
                    disabled={busy}
                    aria-label={`選取 ${row.sku} 商品銷售資料`}
                  />
                </td>
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
      {selectedCount > 0 ? <SelectionActions selectedCount={selectedCount} busy={busy} onDelete={onDeleteSelected} /> : null}
    </div>
  );
}
