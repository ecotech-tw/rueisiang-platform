import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Field, Input, Page, PageHeader, Panel, ReportSummary, SegmentedControl, SelectField, TextField, WorkflowRunPanel } from "../../ui/index.js";
import {
  useConfirmShopeeSales,
  useDiscardShopeePreview,
  usePreviewShopeeSales,
  useShopeePreview,
  useShopeeSalesState,
  useShopeeSalesStatus,
  type ShopeePreview,
} from "./api.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface ShopeeTracking {
  requestId: string;
  mode: "preview" | "import";
  previewToken?: string;
}

function number(value: number): string {
  return value.toLocaleString("zh-TW");
}

function amount(value: number): string {
  return `NT$${number(value)}`;
}

function ShopeePayoutPreview({ preview }: { preview: ShopeePreview }) {
  const rows = [...(preview.dailyPayoutRows ?? [])].sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  const total = rows.reduce((sum, row) => sum + row.payoutAmount, 0);
  return (
    <div className="flex flex-col gap-3">
      {preview.dailyPayoutRows ? (
        <>
          <ReportSummary items={[
            { label: "每日出金合計", value: amount(total) },
            { label: "不重複訂單", value: `${number(preview.uniqueOrders)} 筆` },
            { label: "出金日期", value: `${number(rows.length)} 日` },
          ]} />
          {preview.totalPerformance !== total ? (
            <Alert tone="warning">業績合計 {amount(preview.totalPerformance)} 與可依日期列出的每日出金 {amount(total)} 不同，請核對來源報表的日期欄位。</Alert>
          ) : null}
          {rows.length ? (
            <DataTable aria-label="蝦皮每日出金明細">
              <thead><tr><th>出金日期</th><th className="numeric">出金金額</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.businessDate}>
                    <td data-label="出金日期">{row.businessDate}</td>
                    <td data-label="出金金額" className="numeric">{amount(row.payoutAmount)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td data-label="出金日期">合計</td>
                  <td data-label="出金金額" className="numeric">{amount(total)}</td>
                </tr>
              </tbody>
            </DataTable>
          ) : <p className="muted">本次報表沒有每日出金資料。</p>}
        </>
      ) : <Alert tone="warning">這份預覽尚未包含每日出金明細，請重新解析報表。</Alert>}
    </div>
  );
}

function ShopeeSalesPreview({ preview }: { preview: ShopeePreview }) {
  return (
    <div className="flex flex-col gap-4">
      <ReportSummary items={[
        { label: "商品／選項組合", value: number(preview.uniqueProducts) },
        { label: "商品銷售數量", value: number(preview.totalQuantity) },
        { label: "商品銷售金額", value: amount(preview.totalSalesAmount) },
      ]} />
      <details className="group rounded-[12px] border border-soft-line bg-canvas/74">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-[11px] px-4 py-3 font-semibold text-ink [transition-property:background-color] duration-120 ease-out hover:bg-brand/4 group-open:rounded-b-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary [&::-webkit-details-marker]:hidden">
          <span>商品明細</span>
          <span className="flex items-center gap-3 text-[13px] text-muted">
            <span>{number(preview.rowCount)} 個商品／月份組合</span>
            <span className="group-open:hidden">展開</span>
            <span className="hidden group-open:inline">收合</span>
          </span>
        </summary>
        <div className="overflow-hidden rounded-b-[11px] border-t border-soft-line">
          <DataTable>
            <thead><tr><th>月份</th><th>商品 SKU</th><th>商品名稱</th><th className="numeric">銷售數量</th><th className="numeric">退貨數量</th><th className="numeric">銷售金額</th></tr></thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={`${row.reportMonth}:${row.sku}`}>
                  <td data-label="月份">{row.reportMonth}</td>
                  <td data-label="SKU"><code>{row.sku}</code></td>
                  <td data-label="商品名稱">{row.productName}</td>
                  <td data-label="銷售數量" className="numeric">{number(row.grossQuantity)}</td>
                  <td data-label="退貨數量" className="numeric">{number(row.returnQuantity)}</td>
                  <td data-label="銷售金額" className="numeric">{amount(row.salesAmount)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {preview.rowCount > preview.rows.length ? <p className="muted p-3">表格先顯示前 {number(preview.rows.length)} 列，確認匯入時會處理全部 {number(preview.rowCount)} 列。</p> : null}
        </div>
      </details>
    </div>
  );
}

function savedTracking(): ShopeeTracking | null {
  try {
    const value = sessionStorage.getItem("shopee-sales-tracking");
    if (!value) return null;
    const tracking = JSON.parse(value) as Partial<ShopeeTracking>;
    if (typeof tracking.requestId !== "string") return null;
    if (tracking.mode === "import") return { requestId: tracking.requestId, mode: "import" };
    if (tracking.mode === "preview" && typeof tracking.previewToken === "string") {
      return { requestId: tracking.requestId, mode: "preview", previewToken: tracking.previewToken };
    }
    return null;
  } catch {
    return null;
  }
}

export function ShopeeSales({ embedded = false, sourceField }: { embedded?: boolean; sourceField?: ReactNode } = {}) {
  usePageTitle("蝦皮商品銷售");
  const state = useShopeeSalesState();
  const previewRun = usePreviewShopeeSales();
  const confirmRun = useConfirmShopeeSales();
  const discardPreview = useDiscardShopeePreview();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [scopeId, setScopeId] = useState("");
  const [password, setPassword] = useState("");
  const [activeTab, setActiveTab] = useState<"payout" | "sales">("payout");
  const [tracking, setTracking] = useState<ShopeeTracking | null>(savedTracking);
  useEffect(() => {
    try {
      if (tracking) sessionStorage.setItem("shopee-sales-tracking", JSON.stringify(tracking));
      else sessionStorage.removeItem("shopee-sales-tracking");
    } catch {
      // Progress remains available while this page stays open even when browser storage is disabled.
    }
  }, [tracking]);
  const status = useShopeeSalesStatus(tracking?.requestId ?? state.data?.latestRequestId ?? null);
  const latest = status.data?.runs[0];
  const previewToken = tracking?.mode === "preview" ? tracking.previewToken ?? null : null;
  const previewStatusActive = Boolean(tracking?.mode === "preview" && (!latest || latest.status !== "completed" || latest.conclusion === "success"));
  const previewQuery = useShopeePreview(tracking?.mode === "preview" ? tracking.requestId : null, previewToken, previewStatusActive);
  useEffect(() => {
    if (tracking?.mode === "import" && latest?.status === "completed") setTracking(null);
  }, [latest?.status, tracking?.mode]);

  if (state.isPending) return <div className="boot">載入中…</div>;
  if (!state.data) return <div className="boot"><Alert tone="danger">{state.error?.message ?? "無法載入蝦皮通路設定。"}</Alert></div>;

  const scopes = state.data.scopes;
  const selectedScopeId = scopes.some((scope) => scope.id === scopeId) ? scopeId : scopes[0]?.id ?? "";
  const selectedScope = scopes.find((scope) => scope.id === selectedScopeId);
  const preview = previewQuery.data?.preview ?? null;
  const fileTooLarge = Boolean(file && file.size > MAX_FILE_BYTES);
  const previewInputLocked = Boolean(preview && file && password);
  const trackingRunning = Boolean(tracking && (
    !latest
    || latest.status !== "completed"
    || (tracking.mode === "preview" && latest.conclusion === "success" && !preview && !previewQuery.error)
  ));
  const previewFailed = Boolean(tracking?.mode === "preview" && latest?.status === "completed" && latest.conclusion !== "success");
  const busy = previewRun.isPending || confirmRun.isPending || trackingRunning;
  const blocked = busy || !selectedScopeId || !selectedScope?.driveFolderUrl || !state.data.configured
    || !file || fileTooLarge || !password;

  function forgetPreview() {
    if (tracking?.mode === "preview" && tracking.previewToken) {
      void discardPreview.mutateAsync({ requestId: tracking.requestId, token: tracking.previewToken }).catch(() => undefined);
    }
    setTracking(null);
    setFile(null);
    setPassword("");
    setActiveTab("payout");
    if (inputRef.current) inputRef.current.value = "";
  }

  function execute() {
    if (busy || !selectedScopeId) return;
    if (preview && tracking?.mode === "preview" && tracking.previewToken) {
      if (!file || !password) return;
      confirmRun.mutate({
        file,
        password,
        scopeId: selectedScopeId,
        requestId: tracking.requestId,
        previewToken: tracking.previewToken,
      }, {
        onSuccess: (result) => {
          setTracking({ requestId: result.requestId, mode: "import" });
          setFile(null);
          setPassword("");
          if (inputRef.current) inputRef.current.value = "";
        },
      });
      return;
    }
    if (!file || !password) return;
    if (tracking?.mode === "preview" && tracking.previewToken) {
      void discardPreview.mutateAsync({ requestId: tracking.requestId, token: tracking.previewToken }).catch(() => undefined);
    }
    previewRun.mutate({ file, password, scopeId: selectedScopeId }, {
      onSuccess: (result) => {
        setTracking({ ...result, mode: "preview" });
        setActiveTab("payout");
      },
    });
  }

  const content = (
    <>
      {embedded ? null : <PageHeader title="蝦皮商品銷售" />}
      {!state.data.configured ? <Alert tone="danger">平台還沒設定 GITHUB_TOKEN，現在無法處理報表。</Alert> : null}
      {!scopes.length ? <Alert tone="warning">尚未建立啟用中的蝦皮通路。請先到通路管理新增「種類：通路、平台：蝦皮」。</Alert> : null}
      {selectedScope && !selectedScope.driveFolderUrl ? <Alert tone="danger">「{selectedScope.name}」尚未設定 Google Drive 資料夾，請由有權限的人前往通路管理設定。</Alert> : null}
      <Panel
        title={embedded ? "蝦皮商品銷售" : undefined}
        description="選擇通路與報表檔案，先解析預覽並確認資料，再匯入銷售報表。"
      >
        <form className="admin-form row" onSubmit={(event) => { event.preventDefault(); execute(); }}>
          {sourceField}
          <SelectField
            className="min-w-[180px] flex-[1_1_190px]"
            label="通路"
            required
            value={selectedScopeId}
            onChange={(event) => setScopeId(event.target.value)}
            options={scopes.map((scope) => ({ value: scope.id, label: scope.name }))}
            placeholder="請選擇通路"
            disabled={busy || Boolean(preview) || !scopes.length}
          />
          <Field className="min-w-[260px] flex-[1.6_1_280px]" label="報表檔案" required>
            <Input
              ref={inputRef}
              className="w-full"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              disabled={busy || previewInputLocked}
            />
          </Field>
          <TextField
            className="min-w-[180px] flex-[1_1_190px]"
            label="報表密碼"
            required
            type="password"
            inputClassName="w-full"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="請輸入報表密碼"
            autoComplete="off"
            disabled={busy || previewInputLocked}
          />
          <Button
            className="shrink-0"
            type="submit"
            size="lg"
            icon={preview ? "download" : "analytics"}
            loading={previewRun.isPending || confirmRun.isPending}
            loadingLabel={confirmRun.isPending ? "啟動中…" : "送出中…"}
            disabled={blocked}
          >
            {preview ? "確認匯入" : "解析並預覽"}
          </Button>
          {trackingRunning ? <span className="form-hint">{tracking?.mode === "preview" ? "正在解密並解析報表…" : "背景整理中…"}可以關閉這一頁</span> : null}
        </form>
        {fileTooLarge ? <Alert tone="danger">檔案不能超過 25 MB。</Alert> : null}
        {preview && (!file || !password) ? <p className="form-hint mt-3">請重新選擇預覽時的原始檔案並輸入相同密碼，才能確認匯入。</p> : null}
        {previewRun.error ? <Alert tone="danger">{previewRun.error.message}</Alert> : null}
        {confirmRun.error ? <Alert tone="danger">{confirmRun.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
        {previewQuery.error ? <Alert tone="danger">{previewQuery.error.message}</Alert> : null}
        {previewFailed ? <Alert tone="danger">蝦皮報表解析失敗，請確認檔案與密碼後重新選擇檔案。</Alert> : null}
        {discardPreview.error ? <Alert tone="danger">{discardPreview.error.message}</Alert> : null}
        {preview ? (
          <div className="flex flex-col gap-4 mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong>匯入預覽</strong>
                <p className="muted mt-1">
                  期間：{preview.reportMonths.join("、") || "無"}；{number(preview.sourceRowCount)} 列來源資料整理為 {number(preview.rowCount)} 個商品／月份組合。
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="form-hint">確認匯入後才會更新資料庫</span>
                <Button type="button" variant="secondary" disabled={busy} onClick={forgetPreview}>重新選擇</Button>
              </div>
            </div>
            {preview.warnings.map((warning) => <Alert key={warning} tone="warning">{warning}</Alert>)}
            <div className="sticky top-0 z-10 -mx-[22px] w-[calc(100%+44px)] bg-paper/95 px-[22px] py-2 backdrop-blur-sm">
              <SegmentedControl
                aria-label="蝦皮預覽資料類型"
                skin="outlined"
                size="lg"
                className="max-w-[460px]"
                value={activeTab}
                onChange={(value) => setActiveTab(value as "payout" | "sales")}
                options={[
                  { value: "payout", label: "每日出金", icon: "payments", badge: `${number(preview.dailyPayoutRows?.length ?? 0)} 日` },
                  { value: "sales", label: "商品銷售", icon: "report", badge: `${number(preview.rowCount)} 組` },
                ]}
              />
            </div>
            {activeTab === "payout" ? <ShopeePayoutPreview preview={preview} /> : <ShopeeSalesPreview preview={preview} />}
          </div>
        ) : null}
        {previewFailed ? <Button className="mt-3" type="button" variant="secondary" disabled={busy} onClick={forgetPreview}>重新選擇報表</Button> : null}
        {selectedScope?.driveFolderUrl ? <p className="muted table-note">上傳位置：<a className="link-external" href={selectedScope.driveFolderUrl} target="_blank" rel="noopener noreferrer">{selectedScope.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p> : null}
      </Panel>
      {(tracking || state.data.latestRequestId) ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
          queuedLabel="排隊中"
          runningLabel={tracking?.mode === "preview" ? "解析中" : "整理中"}
          successLabel={tracking?.mode === "preview" ? "預覽完成" : "完成"}
          waitingLabel="等待 GitHub 建立工作…"
        />
      ) : null}
    </>
  );
  return embedded ? content : <Page>{content}</Page>;
}
