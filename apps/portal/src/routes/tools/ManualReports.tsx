import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateManualPayout,
  useCreateManualSales,
  useDeleteManualPayout,
  useDeleteManualSales,
  useManualPayouts,
  useManualReportOptions,
  useManualSales,
  useUpdateManualPayout,
  useUpdateManualSales,
  type ManualPayoutInput,
  type ManualPayoutQuery,
  type ManualPayoutRow,
  type ManualProductOption,
  type ManualRecordSource,
  type ManualReportKind,
  type ManualSalesInput,
  type ManualSalesQuery,
  type ManualSalesRow,
  type ManualSourceFilter,
  type ManualScopeOption,
  type ManualSkuSource,
} from "./manual-reports-api.js";

type DialogState =
  | { kind: "payout"; row?: ManualPayoutRow }
  | { kind: "sales"; row?: ManualSalesRow };

type DeletingState =
  | { kind: "payout"; row: ManualPayoutRow }
  | { kind: "sales"; row: ManualSalesRow };

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

function sourceLabel(source: ManualSkuSource): string {
  return source === "cyberbiz" ? "CYBERBIZ" : "自訂";
}

function recordSourceLabel(source: ManualRecordSource): string {
  return source === "manual" ? "人工修訂" : "匯入資料";
}

function skuSourceLabel(source: ManualSkuSource | null): string {
  return source ? sourceLabel(source) : "匯入報表";
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

export function ManualReports() {
  usePageTitle("報表人工修訂");
  const { permissions } = useSession();
  const canWrite = permissions.has("reports:cyberbiz:write");
  const optionsQuery = useManualReportOptions(canWrite);
  const [payoutFilters, setPayoutFilters] = useState<ManualPayoutQuery>(DEFAULT_PAYOUT_FILTERS);
  const [salesFilters, setSalesFilters] = useState<ManualSalesQuery>(DEFAULT_SALES_FILTERS);
  const payoutsQuery = useManualPayouts(payoutFilters, canWrite);
  const salesQuery = useManualSales(salesFilters, canWrite);
  const deletePayout = useDeleteManualPayout();
  const deleteSales = useDeleteManualSales();
  const toast = useToast();
  const [kind, setKind] = useState<ManualReportKind>("payout");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);

  const scopes = optionsQuery.data?.scopes ?? [];
  const products = optionsQuery.data?.products ?? [];
  const payoutPage = payoutsQuery.data;
  const salesPage = salesQuery.data;
  const queryError = optionsQuery.error ?? payoutsQuery.error ?? salesQuery.error;
  const busy = deletePayout.isPending || deleteSales.isPending;

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
    return <div className="page"><Alert tone="warning">你沒有編輯報表人工資料的權限。</Alert></div>;
  }
  const activeQuery = kind === "payout" ? payoutsQuery : salesQuery;
  if (optionsQuery.isPending || activeQuery.isPending) {
    return <div className="boot">載入報表人工資料中…</div>;
  }
  if (queryError) {
    return <div className="page"><Alert tone="danger">{queryError.message}</Alert></div>;
  }

  return (
    <div className="page manual-report-page">
      <PageHeader
        title="報表人工修訂"
        actions={
          <Button
            icon="plus"
            className="add-action"
            disabled={!scopes.length || busy}
            onClick={() => setDialog({ kind })}
            aria-label={`新增${kind === "payout" ? "出金" : "商品銷售"}資料`}
          >
            <span>新增一列</span>
          </Button>
        }
      />

      <Panel className="manual-report-panel">
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

        {scopes.length === 0 ? <Alert tone="warning">尚未有可選的啟用據點。</Alert> : null}
        {kind === "payout" ? (
          <>
            <PayoutFilters filters={payoutFilters} scopes={scopes} onChange={updatePayoutFilters} />
            <PayoutTable
              rows={payoutPage?.rows ?? []}
              busy={busy}
              sortField={payoutFilters.sortField}
              sortDirection={payoutFilters.sortDirection}
              onSort={(sortField, sortDirection) => updatePayoutFilters({ sortField: sortField as ManualPayoutQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "payout", row })}
              onDelete={(row) => {
                if (row.source === "manual") setDeleting({ kind: "payout", row });
              }}
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
              rows={salesPage?.rows ?? []}
              busy={busy}
              sortField={salesFilters.sortField}
              sortDirection={salesFilters.sortDirection}
              onSort={(sortField, sortDirection) => updateSalesFilters({ sortField: sortField as ManualSalesQuery["sortField"], sortDirection })}
              onEdit={(row) => setDialog({ kind: "sales", row })}
              onDelete={(row) => {
                if (row.source === "manual") setDeleting({ kind: "sales", row });
              }}
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
          scopes={scopes}
          products={products}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`刪除這筆${deleting.kind === "payout" ? "出金" : "商品銷售"}人工資料？`}
          confirmLabel="刪除資料"
          pending={deleting.kind === "payout" ? deletePayout.isPending : deleteSales.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            if (deleting.kind === "payout") {
              deletePayout.mutate(deleting.row.id, {
                onSuccess: () => {
                  toast.show("已刪除人工出金資料");
                  setDeleting(null);
                },
              });
            } else {
              deleteSales.mutate(deleting.row.id, {
                onSuccess: () => {
                  toast.show("已刪除人工商品銷售資料");
                  setDeleting(null);
                },
              });
            }
          }}
        >
          <p>
            {deleting.kind === "payout"
              ? `${deleting.row.scopeName} ${deleting.row.businessDate} 的人工出金資料將被刪除。`
              : `${deleting.row.scopeName} ${deleting.row.reportMonth} ${deleting.row.sku} 的人工商品銷售資料將被刪除。`}
          </p>
          <p className="muted">如果同一列有匯入資料，刪除後會恢復匯入值。</p>
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

function sourceOptions() {
  return [
    { value: "all", label: "全部來源" },
    { value: "imported", label: "匯入資料" },
    { value: "manual", label: "人工修訂" },
  ];
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
        onChange={(event) => onChange({ source: event.target.value as ManualSourceFilter })}
        options={sourceOptions()}
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
        onChange={(event) => onChange({ source: event.target.value as ManualSourceFilter })}
        options={sourceOptions()}
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
            <th>來源</th>
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
              <td data-label="來源"><span className={`manual-record-source manual-record-source-${row.source}`}>{recordSourceLabel(row.source)}</span></td>
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
                  {row.source === "manual" ? (
                    <Button
                      variant="icon"
                      className="danger"
                      icon="trash"
                      disabled={busy}
                      onClick={() => onDelete(row)}
                      title={`刪除 ${row.businessDate} 人工出金資料`}
                      aria-label={`刪除 ${row.businessDate} 人工出金資料`}
                    />
                  ) : null}
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
            <th>來源</th>
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
                <span className={`manual-source manual-source-${row.skuSource ?? "imported"}`}>{skuSourceLabel(row.skuSource)}</span>
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
              <td data-label="來源"><span className={`manual-record-source manual-record-source-${row.source}`}>{recordSourceLabel(row.source)}</span></td>
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
                  {row.source === "manual" ? (
                    <Button
                      variant="icon"
                      className="danger"
                      icon="trash"
                      disabled={busy}
                      onClick={() => onDelete(row)}
                      title={`刪除 ${row.sku} 人工商品銷售資料`}
                      aria-label={`刪除 ${row.sku} 人工商品銷售資料`}
                    />
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
