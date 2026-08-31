import { useRef, useState } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, SelectField, TextField } from "../../ui/index.js";
import {
  useManualSalesProducts,
  useManualSalesScopes,
  useUploadManualSales,
  type ManualSalesResult,
} from "./api.js";
import {
  parseManualCyberbizSales,
  resolveManualSalesPreview,
  type ManualSalesPreview,
} from "./cyberbiz-sales-xlsx.js";
import { readFirstSheet } from "./xlsx.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_VISIBLE_ROWS = 500;

function number(value: number): string {
  return value.toLocaleString("zh-TW");
}

function clearInput(input: HTMLInputElement | null): void {
  if (input) input.value = "";
}

/** 手動匯入 CYBERBIZ 商品銷售總表；先在瀏覽器預覽，再寫進既有月資料匯入器。 */
export function ManualCyberbizSalesPanel({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const scopesQuery = useManualSalesScopes();
  const upload = useUploadManualSales();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<ManualSalesPreview | null>(null);
  const [existingScopeId, setExistingScopeId] = useState("");
  const [newScopeName, setNewScopeName] = useState("");
  const [lastResult, setLastResult] = useState<ManualSalesResult | null>(null);

  const isLegacyPreview = preview?.format === "legacy-net-quantity";
  const productsQuery = useManualSalesProducts(isLegacyPreview);
  const mappedPreview = isLegacyPreview && preview
    ? resolveManualSalesPreview(preview, productsQuery.data?.products ?? [])
    : preview;
  const catalogReady = !isLegacyPreview || !productsQuery.isPending;
  const importRows = mappedPreview?.rows.filter((row) => row.sku.trim()) ?? [];
  const unresolvedProductNames = mappedPreview?.unresolvedProductNames ?? [];

  const scopes = scopesQuery.data?.scopes ?? [];
  const scopeName = existingScopeId
    ? scopes.find((scope) => scope.id === existingScopeId)?.name ?? ""
    : newScopeName.trim();
  const canImport = Boolean(
    scopeName
    && importRows.length
    && catalogReady
    && !unresolvedProductNames.length
    && !reading
    && !upload.isPending,
  );

  function updateSku(sourceRow: number, value: string) {
    setPreview((current) => current
      ? {
          ...current,
          rows: current.rows.map((row) => row.sourceRow === sourceRow ? { ...row, sku: value } : row),
        }
      : current);
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setPreview(null);
    setLastResult(null);
    if (file.size > MAX_FILE_BYTES) {
      setParseError(`檔案不能超過 ${MAX_FILE_BYTES / 1024 / 1024} MB。`);
      return;
    }

    setReading(true);
    try {
      const sheet = await readFirstSheet(file);
      setPreview(parseManualCyberbizSales(sheet));
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "讀不開這個檔案。");
    } finally {
      setReading(false);
    }
  }

  function submit() {
    if (!mappedPreview || !scopeName || !canImport) return;
    upload.mutate(
      {
        scopeName,
        ...(existingScopeId ? { scopeId: existingScopeId } : {}),
        reportMonth: mappedPreview.reportMonth,
        rows: importRows.map(({ sku, grossQuantity, returnQuantity, netQuantity, salesAmount }) => ({
          sku,
          grossQuantity,
          returnQuantity,
          netQuantity,
          salesAmount,
        })),
      },
      {
        onSuccess: (result) => {
          setLastResult(result);
          toast.show(`已匯入「${result.scopeName}」${result.reportMonth} 商品銷售 ${result.rowCount} 筆`);
          setPreview(null);
          setFileName("");
          clearInput(fileInputRef.current);
        },
      },
    );
  }

  if (!canWrite) return null;

  return (
    <details className="manual-sales-details">
      <summary>
        手動上傳商品銷售
        <span className="cell-sub">自動流程以外的 CYBERBIZ xlsx，可補進指定月份</span>
      </summary>
      <div className="manual-sales-body">
        <section className="manual-sales-step">
          <h3>1. 選擇據點</h3>
          <p className="cell-sub">選既有據點會沿用它的歷史資料；新據點會建立手動 scope，仍會納入公司統計。</p>
          <div className="admin-form toolbar">
            <SelectField
              label="既有據點"
              value={existingScopeId}
              disabled={scopesQuery.isPending}
              onChange={(event) => {
                setExistingScopeId(event.target.value);
                if (event.target.value) setNewScopeName("");
              }}
              options={[
                { label: scopesQuery.isPending ? "讀取據點中…" : "（不使用既有據點）", value: "" },
                ...scopes.map((scope) => ({ label: scope.name, value: scope.id })),
              ]}
            />
            <TextField
              label="或新建據點名稱"
              placeholder="例如 中友百貨"
              value={newScopeName}
              disabled={!!existingScopeId}
              onChange={(event) => setNewScopeName(event.target.value)}
              hint="新據點只代表沒有自動抓取來源，商品仍按 CYBERBIZ mapping 匯入。"
            />
          </div>
          {scopesQuery.error ? <Alert tone="danger">{scopesQuery.error.message}</Alert> : null}
        </section>

        <section className="manual-sales-step">
          <h3>2. 選擇檔案</h3>
          <p className="cell-sub">
            支援標準「商品銷售總表」，也支援舊版「出金＋銷售」合併 xlsx（商品名稱＋淨銷售數量）；日期區間必須是完整單一月份。
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          {fileName ? <p className="cell-sub">{fileName}{reading ? "（讀取中…）" : ""}</p> : null}
          {parseError ? <Alert tone="danger">{parseError}</Alert> : null}
          {lastResult?.skippedSkus.length ? (
            <Alert tone="warning">
              已匯入可對應的資料，但略過 {lastResult.skippedSkus.length} 個尚未設定 mapping 的 SKU：
              {lastResult.skippedSkus.join("、")}。補好 mapping 後重匯同一月份即可補回。
            </Alert>
          ) : null}
        </section>

        {mappedPreview ? (
          <section className="manual-sales-step">
            <div className="manual-sales-preview-heading">
              <h3>3. 預覽並匯入</h3>
              <span className="status ui-status-neutral">{mappedPreview.reportMonth}</span>
            </div>
            <p className="cell-sub">
              {mappedPreview.coverageStart} ~ {mappedPreview.coverageEnd}，共 {mappedPreview.rows.length} 筆商品；
              淨銷售數量 {number(mappedPreview.totals.netQuantity)}，售額 {number(mappedPreview.totals.salesAmount)}。
            </p>
            <Alert tone="warning">
              匯入會取代「{scopeName || "尚未選擇據點"}」{mappedPreview.reportMonth} 的既有商品銷售資料；確認檔案與據點正確後再送出。
            </Alert>
            {mappedPreview.format === "legacy-net-quantity" ? (
              <Alert tone="warning">
                這是舊版「出金＋銷售」合併檔，只有淨銷售數量；匯入時會將銷售數量視為淨銷售數量，退貨數量與售額填 0。
                這批資料可用來統計件數，但不會補回營收或退貨。
              </Alert>
            ) : null}
            {isLegacyPreview && productsQuery.isPending ? (
              <Alert tone="warning">正在用 CYBERBIZ 商品目錄比對舊檔品名，完成後才能匯入。</Alert>
            ) : null}
            {isLegacyPreview && productsQuery.error ? (
              <Alert tone="danger">{productsQuery.error.message}仍可直接在下方逐列輸入 SKU；若要使用自動比對，請同步 CYBERBIZ 商品目錄後重新選擇檔案。</Alert>
            ) : null}
            {!productsQuery.isPending && unresolvedProductNames.length ? (
              <Alert tone="danger">
                有 {unresolvedProductNames.length} 個仍有銷售數量的品名尚未對應 SKU，請在下方 SKU 欄手動補上；全部補齊後才能匯入：
                {unresolvedProductNames.slice(0, 10).join("、")}
                {unresolvedProductNames.length > 10 ? " 等" : ""}。
              </Alert>
            ) : null}
            {mappedPreview.skippedRows.length ? (
              <Alert tone="warning">
                有 {mappedPreview.skippedRows.length} 列缺少 SKU 且仍有數值，預覽與匯入都會略過（第 {mappedPreview.skippedRows.slice(0, 10).join("、")} 列
                {mappedPreview.skippedRows.length > 10 ? " 等" : ""}）。
              </Alert>
            ) : null}
            {upload.error ? <Alert tone="danger">{upload.error.message}</Alert> : null}
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>來源列</th>
                    <th>SKU</th>
                    <th>商品名稱</th>
                    <th>類別</th>
                    <th className="numeric">銷售數量</th>
                    <th className="numeric">退回數量</th>
                    <th className="numeric">淨銷售數量</th>
                    <th className="numeric">售額</th>
                  </tr>
                </thead>
                <tbody>
                  {(mappedPreview.rows.length > MAX_VISIBLE_ROWS
                    ? [
                        ...mappedPreview.rows.slice(0, MAX_VISIBLE_ROWS),
                        ...mappedPreview.rows.slice(MAX_VISIBLE_ROWS).filter((row) => (
                          isLegacyPreview && row.netQuantity !== 0 && !row.sku.trim()
                        )),
                      ]
                    : mappedPreview.rows).map((row) => (
                    <tr key={row.sourceRow}>
                      <td data-label="來源列" className="cell-sub">{row.sourceRow}</td>
                      <td data-label="SKU" className="manual-sales-sku-cell">
                        {isLegacyPreview ? (
                          <input
                            className="cell-input manual-sales-sku-input"
                            value={row.sku}
                            placeholder="輸入 SKU"
                            aria-label={`第 ${row.sourceRow} 列 SKU`}
                            aria-invalid={row.netQuantity !== 0 && !row.sku.trim()}
                            onChange={(event) => updateSku(row.sourceRow, event.target.value)}
                            onBlur={() => updateSku(row.sourceRow, row.sku.trim())}
                          />
                        ) : (
                          <span className="cell-strong">{row.sku || "—"}</span>
                        )}
                      </td>
                      <td data-label="商品名稱">{row.productName || "—"}</td>
                      <td data-label="類別" className="cell-sub">{row.category}</td>
                      <td data-label="銷售數量" className="numeric">{number(row.grossQuantity)}</td>
                      <td data-label="退回數量" className="numeric">{number(row.returnQuantity)}</td>
                      <td data-label="淨銷售數量" className="numeric">{number(row.netQuantity)}</td>
                      <td data-label="售額" className="numeric">{number(row.salesAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mappedPreview.rows.length > MAX_VISIBLE_ROWS ? (
              <p className="muted table-note">
                畫面顯示前 {MAX_VISIBLE_ROWS} 筆；舊格式中尚未對應且仍有銷售數量的列也會顯示，方便補 SKU。匯入會包含全部 {importRows.length} 筆已對應商品。
              </p>
            ) : null}
            <Button
              icon="analytics"
              loading={upload.isPending}
              loadingLabel="匯入中…"
              disabled={!canImport}
              onClick={submit}
            >
              {isLegacyPreview && productsQuery.isPending ? "商品對應中…" : scopeName ? `匯入到「${scopeName}」` : "請先選擇據點"}
            </Button>
          </section>
        ) : null}
      </div>
    </details>
  );
}
