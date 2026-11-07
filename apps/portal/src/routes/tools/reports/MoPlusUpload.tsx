import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useToast } from "../../../shell/Toast.js";
import { Alert, Button, DataTable, Field, Input, Panel, SelectField } from "../../../ui/index.js";
import { useImportMoPlusReport, useMoPlusReportScopes, type MoPlusImportResult } from "../api.js";
import { momoReportParser, type ParsedSalesReport } from "./report-adapter.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function formatAmount(value: number): string {
  return `NT$${value.toLocaleString("zh-TW")}`;
}

function SalesTotalsTable({ report }: { report: ParsedSalesReport }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="muted">來源檔商品銷售額（含未對應 SKU）</p>
          <p className="mt-1 text-[24px] font-semibold tabular-nums">{formatAmount(report.salesTotals.salesAmount)}</p>
        </div>
        <p className="form-hint">以已送達與退貨商品計算；退貨金額為負數，不含運費及其他訂單狀態。</p>
      </div>
      <DataTable aria-label="Mo+ 每月商品銷售合計" className="[&_tbody_tr:last-child>td]:border-t-2 [&_tbody_tr:last-child>td]:border-line [&_tbody_tr:last-child]:font-semibold">
        <thead><tr><th>月份</th><th className="numeric">銷售數量</th><th className="numeric">退貨數量</th><th className="numeric">淨銷量</th><th className="numeric">商品銷售額</th></tr></thead>
        <tbody>
          {report.monthlyTotals.map((month) => (
            <tr key={month.reportMonth}>
              <td data-label="月份">{month.reportMonth}</td>
              <td data-label="銷售數量" className="numeric">{month.grossQuantity.toLocaleString("zh-TW")}</td>
              <td data-label="退貨數量" className="numeric">{month.returnQuantity.toLocaleString("zh-TW")}</td>
              <td data-label="淨銷量" className="numeric">{month.netQuantity.toLocaleString("zh-TW")}</td>
              <td data-label="商品銷售額" className="numeric">{formatAmount(month.salesAmount)}</td>
            </tr>
          ))}
          <tr>
            <td data-label="月份">合計</td>
            <td data-label="銷售數量" className="numeric">{report.salesTotals.grossQuantity.toLocaleString("zh-TW")}</td>
            <td data-label="退貨數量" className="numeric">{report.salesTotals.returnQuantity.toLocaleString("zh-TW")}</td>
            <td data-label="淨銷量" className="numeric">{report.salesTotals.netQuantity.toLocaleString("zh-TW")}</td>
            <td data-label="商品銷售額" className="numeric">{formatAmount(report.salesTotals.salesAmount)}</td>
          </tr>
        </tbody>
      </DataTable>
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
  const [error, setError] = useState("");

  const scopes = scopesQuery.data?.scopes ?? [];
  const selectedScopeId = scopes.some((scope) => scope.id === scopeId) ? scopeId : scopes[0]?.id ?? "";
  const pending = importReport.isPending;

  function selectFile(selected: File | undefined) {
    setFile(selected ?? null);
    setPreview(null);
    setImportResult(null);
    setImportedReport(null);
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
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "無法解析這份 Mo+ 對帳明細。");
      } finally {
        setParsing(false);
      }
      return;
    }
    importReport.mutate({ scopeId: selectedScopeId, sourceFileName: file?.name ?? "", rows: preview.rows }, {
      onSuccess: (result) => {
        toast.show("Mo+ 對帳明細已匯入，所涉月份已重新彙整");
        setImportResult(result);
        setImportedReport(preview);
        setPreview(null);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      },
    });
  }

  return (
    <Panel title="Mo+ 商品銷售" description="選擇通路與報表檔案，先解析預覽並確認資料，再匯入銷售報表。">
      {scopesQuery.error ? <Alert tone="danger">{scopesQuery.error.message}</Alert> : null}
      {!scopesQuery.isPending && !scopesQuery.error && !scopes.length ? (
        <Alert tone="warning">尚未建立啟用中的 Mo+ 通路。請先到通路管理新增「種類：通路、平台：Mo+」。</Alert>
      ) : null}
      <div className="admin-form row">
        {sourceField}
        <SelectField
          className="min-w-[180px] flex-[1_1_190px]"
          label="通路"
          required
          value={selectedScopeId}
          onChange={(event) => setScopeId(event.target.value)}
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
      </div>
      <div className="flex flex-col gap-4 mt-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {importReport.error ? <Alert tone="danger">{importReport.error.message}</Alert> : null}
        {importResult && importedReport ? (
          <>
            <Alert tone="success">
              <strong>Mo+ 對帳明細已匯入並完成月份重彙整。</strong>
              <p className="mt-1">本次來源檔商品銷售額：{formatAmount(importedReport.salesTotals.salesAmount)}。</p>
              <p className="mt-1">受影響月份（{importResult.reportMonths.join("、") || importedReport.reportMonths.join("、")}）重彙整後，已對應商品納入共用報表的銷售額：{formatAmount(importResult.salesTotals.salesAmount)}。</p>
              <p className="mt-1">月報金額涵蓋所列月份的 Mo+ 明細，不只本次檔案；未對應 SKU 不計入月報金額。</p>
            </Alert>
            <SalesTotalsTable report={importedReport} />
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
              <span className="form-hint">確認匯入後才會更新資料庫</span>
            </div>
            <SalesTotalsTable report={preview} />
            {preview.warnings.map((warning) => <Alert key={warning} tone="warning">{warning}</Alert>)}
            {preview.skippedRowCount > 0 ? <p className="muted">略過 {preview.skippedRowCount} 列非商品或非已送達／退貨資料。</p> : null}
            <DataTable containerClassName="max-h-[60vh] overflow-y-auto">
              <thead><tr><th>月份</th><th>商品原廠編號／商品編號</th><th>商品名稱</th><th className="numeric">銷售數量</th><th className="numeric">退貨數量</th><th className="numeric">銷售金額</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 100).map((row) => (
                  <tr key={`${row.reportMonth}:${row.sku}`}>
                    <td data-label="月份">{row.reportMonth}</td>
                    <td data-label="SKU"><code>{row.sku}</code></td>
                    <td data-label="商品名稱">{row.productName}</td>
                    <td data-label="銷售數量" className="numeric">{row.grossQuantity.toLocaleString("zh-TW")}</td>
                    <td data-label="退貨數量" className="numeric">{row.returnQuantity.toLocaleString("zh-TW")}</td>
                    <td data-label="銷售金額" className="numeric">{row.salesAmount.toLocaleString("zh-TW")}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {preview.rows.length > 100 ? <p className="muted">表格先顯示前 100 列，實際匯入 {preview.rows.length} 列。</p> : null}
            <p className="muted">找不到原廠編號對應的品項時，匯入完成後可到 <Link className="link" to="/items/sku-mappings">SKU 對應</Link> 手動建立；該商品會先列為待處理，不會被錯誤歸到其他 SKU。</p>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
