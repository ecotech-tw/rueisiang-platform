import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useToast } from "../../../shell/Toast.js";
import { Alert, Button, DataTable, Field, FORM_ROW_SPACING, FormHint, FormRow, Input, Panel, ReportSummary, SegmentedControl, SelectField } from "../../../ui/index.js";
import { useImportMoPlusReport, useMoPlusReportScopes, type MoPlusImportResult } from "../api.js";
import { momoReportParser, type ParsedSalesReport } from "./report-adapter.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function formatAmount(value: number): string {
  return `NT$${value.toLocaleString("zh-TW")}`;
}

function PayoutTotalsTable({ report }: { report: ParsedSalesReport }) {
  return (
    <div className="flex flex-col gap-3">
      <ReportSummary items={[
        { label: "每日出金合計", value: formatAmount(report.payoutTotal) },
        { label: "入帳日數", value: `${report.payoutRows.length.toLocaleString("zh-TW")} 日` },
      ]} />
      {report.payoutRows.length ? (
        <DataTable aria-label="Mo+ 每日出金明細">
          <thead><tr><th>入帳日</th><th className="numeric">實際入帳金額</th></tr></thead>
          <tbody>
            {report.payoutRows.map((row) => (
              <tr key={row.businessDate}>
                <td data-label="入帳日">{row.businessDate}</td>
                <td data-label="實際入帳金額" className="numeric">{formatAmount(row.payoutAmount)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td data-label="入帳日">合計</td>
              <td data-label="實際入帳金額" className="numeric">{formatAmount(report.payoutTotal)}</td>
            </tr>
          </tbody>
        </DataTable>
      ) : <p className="muted">本次檔案沒有已入帳資料。</p>}
      <FormHint>出金日期使用檔案中的「入帳日」，金額使用「實際入帳金額」；不以商品出貨日或商品銷售額推算。</FormHint>
    </div>
  );
}

function SalesSummary({ report }: { report: ParsedSalesReport }) {
  return (
    <div className="flex flex-col gap-2">
      <ReportSummary items={[
        { label: "來源檔商品銷售額（含未對應 SKU）", value: formatAmount(report.salesTotals.salesAmount) },
        { label: "商品／月份組合", value: `${report.rows.length.toLocaleString("zh-TW")} 組` },
      ]} />
      <FormHint>以已送達與退貨商品計算；退貨金額為負數，不含運費及其他訂單狀態。</FormHint>
    </div>
  );
}

function SalesSkuTable({ report }: { report: ParsedSalesReport }) {
  return (
    <div className="flex flex-col gap-3">
      <details className="group rounded-[12px] border border-soft-line bg-canvas/74">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-[11px] px-4 py-3 font-semibold text-ink [transition-property:background-color] duration-120 ease-out hover:bg-brand/4 group-open:rounded-b-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary [&::-webkit-details-marker]:hidden">
          <span>商品 SKU 明細</span>
          <span className="flex items-center gap-3 text-[13px] text-muted">
            <span>{report.rows.length.toLocaleString("zh-TW")} 個商品／月份組合</span>
            <span className="group-open:hidden">展開</span>
            <span className="hidden group-open:inline">收合</span>
          </span>
        </summary>
        <div className="overflow-hidden rounded-b-[11px] border-t border-soft-line">
          {report.rows.length ? (
            <DataTable>
              <thead><tr><th>月份</th><th>商品原廠編號／商品編號</th><th>商品名稱</th><th className="numeric">銷售數量</th><th className="numeric">退貨數量</th><th className="numeric">銷售金額</th></tr></thead>
              <tbody>
                {report.rows.slice(0, 100).map((row) => (
                  <tr key={`${row.reportMonth}:${row.sku}`}>
                    <td data-label="月份">{row.reportMonth}</td>
                    <td data-label="SKU"><code>{row.sku}</code></td>
                    <td data-label="商品名稱">{row.productName}</td>
                    <td data-label="銷售數量" className="numeric">{row.grossQuantity.toLocaleString("zh-TW")}</td>
                    <td data-label="退貨數量" className="numeric">{row.returnQuantity.toLocaleString("zh-TW")}</td>
                    <td data-label="銷售金額" className="numeric">{formatAmount(row.salesAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : <p className="muted p-4">本次檔案沒有符合銷售狀態的商品明細。</p>}
          {report.rows.length > 100 ? <p className="muted p-3">表格先顯示前 100 列，實際匯入 {report.rows.length.toLocaleString("zh-TW")} 列。</p> : null}
        </div>
      </details>
      <p className="muted">找不到原廠編號對應的品項時，匯入完成後可到 <Link className="link" to="/items/sku-mappings">SKU 對應</Link> 手動建立；該商品會先列為待處理，不會被錯誤歸到其他 SKU。</p>
    </div>
  );
}

function ReportBreakdown({ report, activeTab, onTabChange }: {
  report: ParsedSalesReport;
  activeTab: "payout" | "sales";
  onTabChange: (tab: "payout" | "sales") => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="sticky top-0 z-10 w-full bg-paper/95 py-2 backdrop-blur-sm">
        <SegmentedControl
          aria-label="Mo+ 預覽資料類型"
          skin="outlined"
          size="lg"
          className="max-w-[460px]"
          value={activeTab}
          onChange={(value) => onTabChange(value as "payout" | "sales")}
          options={[
            { value: "payout", label: "每日出金", icon: "payments", badge: `${report.payoutRows.length.toLocaleString("zh-TW")} 日` },
            { value: "sales", label: "商品銷售", icon: "report", badge: `${report.rows.length.toLocaleString("zh-TW")} 組` },
          ]}
        />
      </div>
      {activeTab === "payout" ? (
        <section aria-label="每日出金資料" className="min-w-0">
          <PayoutTotalsTable report={report} />
        </section>
      ) : (
        <section aria-label="商品銷售資料" className="min-w-0 flex flex-col gap-4">
          <SalesSummary report={report} />
          <SalesSkuTable report={report} />
        </section>
      )}
    </div>
  );
}

export function MoPlusUpload({ sourceField }: { sourceField?: ReactNode }) {
  const scopesQuery = useMoPlusReportScopes(true);
  const importReport = useImportMoPlusReport();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scopeId, setScopeId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ParsedSalesReport | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importResult, setImportResult] = useState<MoPlusImportResult | null>(null);
  const [importedReport, setImportedReport] = useState<ParsedSalesReport | null>(null);
  const [activeTab, setActiveTab] = useState<"payout" | "sales">("payout");
  const [error, setError] = useState("");

  const scopes = scopesQuery.data?.scopes ?? [];
  const selectedScopeId = scopes.some((scope) => scope.id === scopeId) ? scopeId : scopes[0]?.id ?? "";
  const pending = importReport.isPending;

  function selectFile(selected: File | undefined) {
    setFile(selected ?? null);
    setPreview(null);
    setImportResult(null);
    setImportedReport(null);
    setActiveTab("payout");
    setError(selected && selected.size > MAX_FILE_BYTES ? "檔案不能超過 25 MB。" : "");
  }

  async function execute() {
    if (pending || parsing || !selectedScopeId) return;
    if (!preview) {
      if (!file || file.size > MAX_FILE_BYTES) return;
      setError("");
      setParsing(true);
      try {
        setPreview(await momoReportParser.parse(file));
        setActiveTab("payout");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "無法解析這份 Mo+ 對帳明細。");
      } finally {
        setParsing(false);
      }
      return;
    }
    importReport.mutate({
      scopeId: selectedScopeId,
      sourceFileName: file?.name ?? "",
      salesRows: preview.rows,
      payoutRows: preview.payoutRows,
    }, {
      onSuccess: (result) => {
        toast.show("Mo+ 對帳明細已匯入，所涉月份已重新彙整");
        setImportResult(result);
        setImportedReport(preview);
        setActiveTab("payout");
        setPreview(null);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      },
    });
  }

  return (
    <Panel grows title="Mo+ 對帳報表" description="匯入商品銷售月報與依入帳日彙總的每日出金。">
      {scopesQuery.error ? <Alert tone="danger">{scopesQuery.error.message}</Alert> : null}
      {!scopesQuery.isPending && !scopesQuery.error && !scopes.length ? (
        <Alert tone="warning">尚未建立啟用中的 Mo+ 通路。請先到通路管理新增「種類：通路、平台：Mo+」。</Alert>
      ) : null}
      <FormRow className={`${FORM_ROW_SPACING} flex-none`}>
        {sourceField}
        <SelectField
          className="min-w-[180px] flex-[1_1_190px]"
          label="通路"
          required
          value={selectedScopeId}
          onChange={(event) => {
            setScopeId(event.target.value);
            setImportResult(null);
            setImportedReport(null);
          }}
          options={scopes.map((scope) => ({ label: scope.name, value: scope.id }))}
          placeholder="請選擇通路"
          disabled={pending || parsing || !scopes.length}
        />
        <Field className="min-w-[260px] flex-[1.6_1_280px]" label="報表檔案" required>
          <Input
            ref={inputRef}
            className="w-full"
            type="file"
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => selectFile(event.target.files?.[0])}
            disabled={pending || parsing}
          />
        </Field>
        <Button
          className="shrink-0"
          type="button"
          size="lg"
          icon={preview ? "download" : "analytics"}
          loading={pending || parsing}
          loadingLabel={pending ? "匯入中…" : "解析中…"}
          disabled={!selectedScopeId || pending || parsing || (!preview && (!file || file.size > MAX_FILE_BYTES))}
          onClick={() => void execute()}
        >
          {preview ? "確認匯入" : "解析並預覽"}
        </Button>
      </FormRow>
      <div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {importReport.error ? <Alert tone="danger">{importReport.error.message}</Alert> : null}
        {importResult && importedReport ? (
          <>
            <Alert tone="success">
              <strong>Mo+ 對帳明細已匯入，銷售月報與每日出金已更新。</strong>
              <p className="mt-1">受影響月份（{importResult.reportMonths.join("、") || importedReport.reportMonths.join("、")}）重彙整後，已對應商品納入共用報表的銷售額：{formatAmount(importResult.salesTotals.salesAmount)}。</p>
              <p className="mt-1">月報金額涵蓋所列月份的 Mo+ 明細，不只本次檔案；未對應 SKU 不計入月報金額。</p>
            </Alert>
            {importedReport.warnings.map((warning) => <Alert key={warning} tone="warning">{warning}</Alert>)}
            <ReportBreakdown report={importedReport} activeTab={activeTab} onTabChange={setActiveTab} />
          </>
        ) : null}
        {importResult?.skippedSkus.length ? (
          <Alert tone="warning">
            {importResult.skippedSkus.length} 個 SKU 尚未對應，因此未納入銷售報表：{importResult.skippedSkus.join("、")}。請到 <Link className="link" to="/items/sku-mappings">SKU 對應</Link> 完成設定後重新匯入。
          </Alert>
        ) : null}

        {preview ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong>匯入預覽</strong>
                <p className="muted mt-1">月份：{preview.reportMonths.join("、")}；{preview.sourceRowCount} 列來源資料整理為 {preview.rows.length} 個商品／月份組合。</p>
              </div>
              <FormHint as="span">確認匯入後才會更新資料庫</FormHint>
            </div>
            {preview.warnings.map((warning) => <Alert key={warning} tone="warning">{warning}</Alert>)}
            <ReportBreakdown report={preview} activeTab={activeTab} onTabChange={setActiveTab} />
            {preview.skippedRowCount > 0 ? <p className="muted">略過 {preview.skippedRowCount} 列非商品或非已送達／退貨資料。</p> : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
