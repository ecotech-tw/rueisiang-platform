import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
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
  type ManualPayoutRow,
  type ManualProductOption,
  type ManualReportKind,
  type ManualSalesInput,
  type ManualSalesRow,
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
  const [skuSource, setSkuSource] = useState<ManualSkuSource>(state.kind === "sales" ? state.row?.skuSource ?? "cyberbiz" : "cyberbiz");
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
      if (state.row) updatePayout.mutate({ ...input, id: state.row.id }, { onSuccess });
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
      if (state.row) updateSales.mutate({ ...input, id: state.row.id }, { onSuccess });
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
  const payoutsQuery = useManualPayouts(canWrite);
  const salesQuery = useManualSales(canWrite);
  const deletePayout = useDeleteManualPayout();
  const deleteSales = useDeleteManualSales();
  const toast = useToast();
  const [kind, setKind] = useState<ManualReportKind>("payout");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);

  const scopes = optionsQuery.data?.scopes ?? [];
  const products = optionsQuery.data?.products ?? [];
  const payoutRows = payoutsQuery.data?.rows ?? [];
  const salesRows = salesQuery.data?.rows ?? [];
  const queryError = optionsQuery.error ?? payoutsQuery.error ?? salesQuery.error;
  const busy = deletePayout.isPending || deleteSales.isPending;

  if (!canWrite) {
    return <div className="page"><Alert tone="warning">你沒有編輯報表人工資料的權限。</Alert></div>;
  }
  if (optionsQuery.isPending || payoutsQuery.isPending || salesQuery.isPending) {
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
          <PayoutTable
            rows={payoutRows}
            busy={busy}
            onEdit={(row) => setDialog({ kind: "payout", row })}
            onDelete={(row) => setDeleting({ kind: "payout", row })}
          />
        ) : (
          <SalesTable
            rows={salesRows}
            busy={busy}
            onEdit={(row) => setDialog({ kind: "sales", row })}
            onDelete={(row) => setDeleting({ kind: "sales", row })}
          />
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

function PayoutTable({
  rows,
  busy,
  onEdit,
  onDelete,
}: {
  rows: ManualPayoutRow[];
  busy: boolean;
  onEdit: (row: ManualPayoutRow) => void;
  onDelete: (row: ManualPayoutRow) => void;
}) {
  if (!rows.length) return <p className="manual-report-empty">目前沒有人工出金資料。</p>;
  return (
    <div className="table-scroll">
      <table className="data-table manual-report-table">
        <thead>
          <tr>
            <th>據點</th>
            <th>日期</th>
            <th className="numeric">出金金額</th>
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
  onEdit,
  onDelete,
}: {
  rows: ManualSalesRow[];
  busy: boolean;
  onEdit: (row: ManualSalesRow) => void;
  onDelete: (row: ManualSalesRow) => void;
}) {
  if (!rows.length) return <p className="manual-report-empty">目前沒有人工商品銷售資料。</p>;
  return (
    <div className="table-scroll">
      <table className="data-table manual-report-table manual-sales-table">
        <thead>
          <tr>
            <th>據點</th>
            <th>月份</th>
            <th>SKU</th>
            <th>商品</th>
            <th className="numeric">數量</th>
            <th className="numeric">銷售金額</th>
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
                <span className={`manual-source manual-source-${row.skuSource}`}>{sourceLabel(row.skuSource)}</span>
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
