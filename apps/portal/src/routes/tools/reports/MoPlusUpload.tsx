import { useRef, useState } from "react";
import { Link } from "react-router";
import { useToast } from "../../../shell/Toast.js";
import { Alert, Button, DataTable, Field, Input, Panel, SelectField } from "../../../ui/index.js";
import { useImportMoPlusReport, useMoPlusReportScopes, type MoPlusImportResult } from "../api.js";
import { moPlusReportParser, type ParsedSalesReport } from "./report-adapter.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function MoPlusUpload() {
  const scopesQuery = useMoPlusReportScopes(true);
  const importReport = useImportMoPlusReport();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [scopeId, setScopeId] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ParsedSalesReport | null>(null);
  const [importResult, setImportResult] = useState<MoPlusImportResult | null>(null);
  const [error, setError] = useState("");

  const scopes = scopesQuery.data?.scopes ?? [];
  const selectedScopeId = scopes.some((scope) => scope.id === scopeId) ? scopeId : scopes[0]?.id ?? "";
  const pending = importReport.isPending;

  async function selectFile(file: File | undefined) {
    setPreview(null);
    setImportResult(null);
    setError("");
    if (!file) return;
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setError("檔案不能超過 25 MB。");
      return;
    }
    try {
      setPreview(await moPlusReportParser.parse(file));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "無法解析這份 Mo+ 對帳明細。");
    }
  }

  function submit() {
    if (!preview || !selectedScopeId || pending) return;
    importReport.mutate({ scopeId: selectedScopeId, rows: preview.rows }, {
      onSuccess: (result) => {
        toast.show(`已匯入 ${result.rowCount.toLocaleString("zh-TW")} 筆商品銷售資料`);
        setImportResult(result);
        setPreview(null);
        setFileName("");
        if (inputRef.current) inputRef.current.value = "";
      },
    });
  }

  return (
    <Panel title="Mo+ 商品銷售" description="上傳 Mo+ 對帳明細。系統讀取「訂單明細」工作表，以出貨確認日歸入月份，並依商品原廠編號自動比對平台 SKU。">
      {scopesQuery.error ? <Alert tone="danger">{scopesQuery.error.message}</Alert> : null}
      {!scopesQuery.isPending && !scopesQuery.error && !scopes.length ? (
        <Alert tone="warning">尚未建立啟用中的 Mo+ 通路。請先到通路管理新增「種類：通路、平台：Mo+」。</Alert>
      ) : null}
      <div className="flex flex-col gap-4">
        <SelectField
          label="Mo+ 通路"
          required
          value={selectedScopeId}
          onChange={(event) => setScopeId(event.target.value)}
          options={scopes.map((scope) => ({ label: scope.name, value: scope.id }))}
          disabled={pending || !scopes.length}
        />
        <Field label="Mo+ 對帳明細（.xls 或 .xlsx）">
          <Input
            ref={inputRef}
            className="w-full"
            type="file"
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void selectFile(event.target.files?.[0])}
            disabled={pending}
          />
        </Field>
        {fileName ? <p className="muted -mt-2">{fileName}</p> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {importReport.error ? <Alert tone="danger">{importReport.error.message}</Alert> : null}
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
            {preview.warnings.map((warning) => <Alert key={warning} tone="warning">{warning}</Alert>)}
            {preview.skippedRowCount > 0 ? <p className="muted">略過 {preview.skippedRowCount} 列非商品或非已送達／退貨資料。</p> : null}
            <DataTable>
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
            <Button size="lg" icon="download" loading={pending} loadingLabel="匯入中…" disabled={!selectedScopeId} onClick={submit}>確認匯入</Button>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
