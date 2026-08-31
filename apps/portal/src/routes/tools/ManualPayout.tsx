import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import { useManualPayoutScopes, useUploadManualPayout } from "./api.js";
import { readFirstSheet, toAmount, toBusinessDate, type Sheet } from "./xlsx.js";

/**
 * 手動上傳出金報表。
 *
 * 掛在「出金表執行」頁底下而不是自成一頁：兩者做的是同一件事（把出金資料弄進 D1），
 * 只是一個走 Actions、一個走人工補檔，分開兩個入口反而要使用者記住去哪裡找。
 *
 * 一律先預覽再送出：欄位位置每份檔案都可能不同，偵測錯了要看得出來並且改得掉，
 * 不能讓它安靜地把錯的數字寫進 D1。
 */

/** 標題列可能在第 1 或第 2 列——整理過的檔案第 1 列是「日期: ... ~ ...」這種說明。 */
const HEADER_ROWS = [1, 2, 3];

const DATE_HINTS = ["關帳時間", "關帳日期", "日期", "營業日"];
/*
 * 金額欄的候選，依偏好排序。
 *
 * 不同時期整理出來的檔案不一樣：有的只有「收入金額」（每一列都有值），有的同時有
 * 已整理好的「公司POS」（每次關帳只出現一次，而且「代班外帳」那種列只有它有值）。
 * 有「公司POS」時優先用它，沒有時才退回「收入金額」；最後仍由使用者對著各欄合計確認。
 */
const AMOUNT_HINTS = ["公司POS", "收入金額", "百貨POS", "營業額", "銷售金額", "金額"];
/** 表格結尾的合計列。它沒有關帳時間，不排除的話會被併進最後一天。 */
const TOTAL_HINTS = ["總計", "合計", "小計", "Total"];

function isTotalRow(sheet: Sheet, row: number): boolean {
  return sheet.columns.some((column) => {
    const value = sheet.cells.get(`${column}${row}`);
    return typeof value === "string" && TOTAL_HINTS.some((hint) => value.includes(hint));
  });
}

interface Detected {
  headerRow: number;
  dateColumn: string;
  amountColumn: string;
  headers: Array<{ column: string; label: string }>;
}

/** 找出標題列與兩個關鍵欄位。找不到就回 null，讓使用者自己指定。 */
function detect(sheet: Sheet): Detected | null {
  for (const headerRow of HEADER_ROWS) {
    const headers = sheet.columns
      .map((column) => ({ column, label: String(sheet.cells.get(`${column}${headerRow}`) ?? "").trim() }))
      .filter((entry) => entry.label);
    if (headers.length < 2) continue;
    const dateColumn = headers.find((entry) => DATE_HINTS.some((hint) => entry.label.includes(hint)))?.column;
    // 有「公司POS」時優先用已整理好的每日出金欄；沒有時才使用每列的「收入金額」。
    if (!dateColumn) continue;
    const amountColumn = AMOUNT_HINTS
      .flatMap((hint) => headers.filter((entry) => entry.label.includes(hint)))
      .find((entry) => {
        if (entry.column === dateColumn) return false;
        // 有些「公司POS」是沒有快取值的陣列公式，解析不到資料時要繼續回退到其他欄位。
        return !entry.label.includes("公司POS")
          || summarise(sheet, headerRow, dateColumn, entry.column).days.length > 0;
      })?.column;
    if (amountColumn) return { headerRow, dateColumn, amountColumn, headers };
  }
  return null;
}

interface DayRow {
  businessDate: string;
  payoutAmount: number;
  rowCount: number;
}

function isValidBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sortPreviewDays(days: DayRow[]): DayRow[] {
  return [...days].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

function ManualPayoutPreviewDialog({
  day,
  existingDates,
  onClose,
  onSave,
}: {
  day: DayRow | null;
  existingDates: ReadonlySet<string>;
  onClose: () => void;
  onSave: (day: DayRow) => void;
}) {
  const [businessDate, setBusinessDate] = useState(day?.businessDate ?? "");
  const [amount, setAmount] = useState(day ? String(day.payoutAmount) : "");
  const payoutAmount = Number(amount);
  const dateError = businessDate.trim() === ""
    ? "請輸入關帳日期。"
    : !isValidBusinessDate(businessDate)
      ? "日期需為有效的 YYYY-MM-DD。"
      : existingDates.has(businessDate)
        ? "預覽中已經有這個日期，請先修改另一筆資料。"
        : undefined;
  const amountError = amount.trim() === ""
    ? "請輸入出金金額。"
    : !Number.isSafeInteger(payoutAmount)
      ? "金額需為整數。"
      : undefined;
  const valid = !dateError && !amountError;

  return (
    <Dialog
      title={day ? `編輯 ${day.businessDate} 預覽資料` : "新增預覽日期"}
      titleMeta={day
        ? "只會修改這次匯入的預覽，按下匯入後才會送出。"
        : "新增一筆這次匯入的預覽資料，按下匯入後才會送出。"}
      className="confirm-card"
      onClose={onClose}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          onSave({ businessDate, payoutAmount, rowCount: day?.rowCount ?? 0 });
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!valid}>
            {day ? "套用到預覽" : "加入預覽"}
          </Button>
        </>
      }
    >
      <TextField
        label="關帳日期"
        required
        autoFocus
        type="date"
        value={businessDate}
        onChange={(event) => setBusinessDate(event.target.value)}
        inputClassName="cell-input"
        error={dateError}
      />
      <TextField
        label="出金金額"
        required
        type="number"
        step="1"
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        inputClassName="cell-input"
        error={amountError}
      />
    </Dialog>
  );
}

/**
 * 逐列加總成日資料。
 *
 * 三個從真實檔案學到的規則：
 * 1. 關帳時間是**合併儲存格**——同一次關帳只有一列有值，其餘留空。空的要沿用同一組的
 *    時間，否則那些列的金額整批消失（04 月那份實測少算 22,373）。
 * 2. 有值的那一列不一定是第一列。05 月那份的第 3 列是空的、4–6 列才有時間，所以往上
 *    找不到時要往下找，不能直接放棄（那會丟掉一筆 1,800）。
 * 3. 表格最後有「總計」列，它沒有關帳時間。不排除的話會被規則 1、2 併進某一天。
 */
function summarise(sheet: Sheet, headerRow: number, dateColumn: string, amountColumn: string) {
  interface RawRow { row: number; date: string; amount: number | null; hasAmount: boolean }
  const raws: RawRow[] = [];
  for (let row = headerRow + 1; row <= sheet.maxRow; row += 1) {
    const rawDate = sheet.cells.get(`${dateColumn}${row}`);
    const rawAmount = sheet.cells.get(`${amountColumn}${row}`);
    if (rawDate === undefined && rawAmount === undefined) continue;
    if (isTotalRow(sheet, row)) continue;
    raws.push({
      row,
      date: toBusinessDate(rawDate),
      amount: rawAmount === undefined ? null : toAmount(rawAmount),
      hasAmount: rawAmount !== undefined,
    });
  }

  // 公司POS 的陣列公式會把總計放在最後一筆資料的下一列，該列只有快取金額、沒有日期。
  // 必須在補日期前移除，否則它會沿用最後一天而被算進日資料。
  const trailing = raws.at(-1);
  const amountLabel = String(sheet.cells.get(`${amountColumn}${headerRow}`) ?? "");
  if (trailing && !trailing.date && trailing.amount !== null && amountLabel.includes("公司POS")) {
    const previousTotal = raws.slice(0, -1).reduce((sum, raw) => sum + (raw.amount ?? 0), 0);
    if (Math.abs(previousTotal - trailing.amount) < 0.01) raws.pop();
  }

  // 先往下補（同一組的後續列），再往上補（值不在第一列的那種）。
  let carried = "";
  for (const raw of raws) {
    if (raw.date) carried = raw.date;
    else raw.date = carried;
  }
  let upcoming = "";
  for (let index = raws.length - 1; index >= 0; index -= 1) {
    const raw = raws[index];
    if (!raw) continue;
    if (raw.date) upcoming = raw.date;
    else raw.date = upcoming;
  }

  const byDate = new Map<string, DayRow>();
  const skipped: number[] = [];
  for (const raw of raws) {
    // 金額空白是正常的：「公司POS」這類欄位只在每次關帳的最後一列有值。
    if (!raw.hasAmount) continue;
    if (!raw.date || raw.amount === null) {
      skipped.push(raw.row);
      continue;
    }
    const existing = byDate.get(raw.date);
    if (existing) {
      existing.payoutAmount += raw.amount;
      existing.rowCount += 1;
    } else {
      byDate.set(raw.date, { businessDate: raw.date, payoutAmount: raw.amount, rowCount: 1 });
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  return { days, skipped, total: days.reduce((sum, day) => sum + day.payoutAmount, 0) };
}

export function ManualPayoutPanel({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const scopesQuery = useManualPayoutScopes();
  const upload = useUploadManualPayout();

  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [parseError, setParseError] = useState("");
  const [headerRow, setHeaderRow] = useState(2);
  const [dateColumn, setDateColumn] = useState("");
  const [amountColumn, setAmountColumn] = useState("");
  const [existingScopeId, setExistingScopeId] = useState("");
  const [newScopeName, setNewScopeName] = useState("");
  const [previewDays, setPreviewDays] = useState<DayRow[]>([]);
  const [editingDay, setEditingDay] = useState<DayRow | null>(null);
  const [deletingDay, setDeletingDay] = useState<DayRow | null>(null);
  const [addingDay, setAddingDay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scopes = scopesQuery.data?.scopes ?? [];
  const headerLabels = useMemo(() => {
    if (!sheet) return [];
    return sheet.columns.map((column) => ({
      column,
      label: String(sheet.cells.get(`${column}${headerRow}`) ?? "").trim(),
    }));
  }, [sheet, headerRow]);

  const preview = useMemo(() => {
    if (!sheet || !dateColumn || !amountColumn) return null;
    return summarise(sheet, headerRow, dateColumn, amountColumn);
  }, [sheet, headerRow, dateColumn, amountColumn]);

  useEffect(() => {
    setPreviewDays(preview?.days ?? []);
    setEditingDay(null);
    setDeletingDay(null);
    setAddingDay(false);
  }, [preview]);

  const previewTotal = previewDays.reduce((sum, day) => sum + day.payoutAmount, 0);

  /*
   * 每個欄位的合計。
   *
   * 哪一欄才是對的沒辦法可靠地自動判斷（不同檔案不一樣），但使用者知道自己那個月大概
   * 多少錢——把合計直接印在選項上，挑起來就變成一眼的事，不必先匯入才發現選錯。
   */
  const columnTotals = useMemo(() => {
    if (!sheet || !dateColumn) return new Map<string, number>();
    const totals = new Map<string, number>();
    for (const { column } of headerLabels) {
      if (column === dateColumn) continue;
      const summary = summarise(sheet, headerRow, dateColumn, column);
      if (summary.days.length) totals.set(column, summary.total);
    }
    return totals;
  }, [sheet, headerRow, dateColumn, headerLabels]);

  const amountOptions = useMemo(() => headerLabels.map((entry) => {
    const total = entry.column === amountColumn && preview
      ? previewTotal
      : columnTotals.get(entry.column);
    const name = entry.label ? `${entry.column}：${entry.label}` : entry.column;
    return {
      label: total === undefined ? name : `${name}（合計 ${total.toLocaleString("zh-TW")}）`,
      value: entry.column,
    };
  }), [headerLabels, columnTotals, amountColumn, preview, previewTotal]);

  const scopeName = existingScopeId
    ? scopes.find((scope) => scope.id === existingScopeId)?.name ?? ""
    : newScopeName.trim();

  async function pick(file: File | undefined) {
    if (!file) return;
    setParseError("");
    setSheet(null);
    setPreviewDays([]);
    setEditingDay(null);
    setDeletingDay(null);
    setAddingDay(false);
    setFileName(file.name);
    try {
      const parsed = await readFirstSheet(file);
      setSheet(parsed);
      const found = detect(parsed);
      if (found) {
        setHeaderRow(found.headerRow);
        setDateColumn(found.dateColumn);
        setAmountColumn(found.amountColumn);
      } else {
        setDateColumn("");
        setAmountColumn("");
        setParseError("認不出關帳時間與金額欄位，請自己指定。");
      }
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "讀不開這個檔案。");
    }
  }

  function submit() {
    if (!previewDays.length || !scopeName) return;
    upload.mutate(
      {
        scopeName,
        ...(existingScopeId ? { scopeId: existingScopeId } : {}),
        rows: previewDays.map((day) => ({ businessDate: day.businessDate, payoutAmount: day.payoutAmount })),
      },
      {
        onSuccess: (result) => {
          toast.show(`已匯入${result.scopeName} ${result.dayCount} 天，合計 ${result.total.toLocaleString("zh-TW")}`);
          setSheet(null);
          setFileName("");
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
      },
    );
  }

  function addPreviewDay(added: DayRow) {
    setPreviewDays((current) => sortPreviewDays([...current, added]));
    setAddingDay(false);
    toast.show(`已新增 ${added.businessDate} 預覽資料`);
  }

  function savePreviewDay(updated: DayRow) {
    if (!editingDay) return;
    setPreviewDays((current) => sortPreviewDays(current.map((day) => (
      day.businessDate === editingDay.businessDate ? updated : day
    ))));
    setEditingDay(null);
    toast.show(`已更新 ${updated.businessDate} 預覽資料`);
  }

  function deletePreviewDay() {
    if (!deletingDay) return;
    const removed = deletingDay;
    setPreviewDays((current) => current.filter((day) => day.businessDate !== removed.businessDate));
    setDeletingDay(null);
    toast.show(`已從預覽刪除 ${removed.businessDate}`);
  }

  if (!canWrite) return null;

  return (
    <>
      <details className="manual-payout-details">
      <summary>
        手動上傳出金
        <span className="cell-sub">退租 POS 的店自動流程抓不到，在這裡補檔</span>
      </summary>
      <div className="manual-payout-body">
      <section className="manual-payout-step">
        <h3>1. 選擇據點</h3>
        <p className="cell-sub">以前在系統裡跑過的店請選既有據點，才不會讓同一家店的歷史被拆成兩份。</p>
        <div className="admin-form toolbar">
          <SelectField
            label="既有據點"
            value={existingScopeId}
            onChange={(event) => {
              setExistingScopeId(event.target.value);
              if (event.target.value) setNewScopeName("");
            }}
            options={[
              { label: "（不使用既有據點）", value: "" },
              ...scopes.map((scope) => ({ label: scope.name, value: scope.id })),
            ]}
          />
          <TextField
            label="或新建據點名稱"
            placeholder="例如 中友百貨"
            value={newScopeName}
            disabled={!!existingScopeId}
            onChange={(event) => setNewScopeName(event.target.value)}
            hint="新建的據點會用 manual 通路，公司總計照樣算得到。"
          />
        </div>
      </section>

      <section className="manual-payout-step">
        <h3>2. 選擇檔案</h3>
        <p className="cell-sub">CYBERBIZ 匯出的出金報表 xlsx；整理過、多了對帳欄位的也可以。</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx"
          onChange={(event) => void pick(event.target.files?.[0])}
        />
        {fileName ? <p className="cell-sub">{fileName}</p> : null}
        {parseError ? <Alert tone="danger">{parseError}</Alert> : null}
      </section>

      {sheet ? (
        <section className="manual-payout-step">
          <h3>3. 確認欄位</h3>
          <p className="cell-sub">不同時期的檔案格式不一樣：有的用「收入金額」，有的要用「公司POS」（代班外帳那種列只有它有值）。對著括號裡的合計挑，不要用「入庫金額」——那是每次關帳重複列印的繳庫數字。</p>
          <div className="admin-form toolbar">
            <SelectField
              label="標題列"
              value={String(headerRow)}
              onChange={(event) => setHeaderRow(Number(event.target.value))}
              options={HEADER_ROWS.map((row) => ({ label: `第 ${row} 列`, value: String(row) }))}
            />
            <SelectField
              label="關帳時間欄"
              value={dateColumn}
              onChange={(event) => setDateColumn(event.target.value)}
              options={[{ label: "請選擇", value: "" }, ...headerLabels.map((entry) => ({
                label: entry.label ? `${entry.column}：${entry.label}` : entry.column,
                value: entry.column,
              }))]}
            />
            <SelectField
              label="金額欄"
              value={amountColumn}
              onChange={(event) => setAmountColumn(event.target.value)}
              options={[{ label: "請選擇", value: "" }, ...amountOptions]}
              hint="括號裡是該欄的合計，挑跟你預期相符的那一欄。"
            />
          </div>
        </section>
      ) : null}

      {preview ? (
        <section className="manual-payout-step">
          <div className="manual-payout-preview-heading">
            <h3>4. 預覽</h3>
            <Button
              variant="secondary"
              icon="plus"
              disabled={upload.isPending}
              onClick={() => setAddingDay(true)}
            >
              新增日期
            </Button>
          </div>
          <p className="cell-sub">{previewDays.length
            ? `${previewDays[0]?.businessDate} ~ ${previewDays[previewDays.length - 1]?.businessDate}，共 ${previewDays.length} 天，合計 ${previewTotal.toLocaleString("zh-TW")}`
            : preview.days.length
              ? "預覽中的資料已全部刪除，請至少保留一筆資料。"
              : "這份檔案解析不出任何資料列。"}</p>
          {preview.skipped.length ? (
            <Alert tone="warning">
              有 {preview.skipped.length} 列的日期或金額解析不出來，已略過（第 {preview.skipped.slice(0, 10).join("、")} 列
              {preview.skipped.length > 10 ? " 等" : ""}）。欄位選錯的話請回上一步調整。
            </Alert>
          ) : null}
          {upload.error ? <Alert tone="danger">{upload.error.message}</Alert> : null}
          {previewDays.length ? (
            <>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr><th>關帳日期</th><th className="numeric">金額</th><th className="numeric">來源列數</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {previewDays.map((day) => (
                      <tr key={day.businessDate}>
                        <td data-label="關帳日期">{day.businessDate}</td>
                        <td data-label="金額" className="numeric">{day.payoutAmount.toLocaleString("zh-TW")}</td>
                        <td data-label="來源列數" className="numeric cell-sub">{day.rowCount || "手動"}</td>
                        <td data-label="操作">
                          <div className="row-actions">
                            <Button
                              variant="icon"
                              icon="edit"
                              disabled={upload.isPending}
                              onClick={() => setEditingDay(day)}
                              title={`編輯 ${day.businessDate} 預覽資料`}
                              aria-label={`編輯 ${day.businessDate} 預覽資料`}
                            />
                            <Button
                              variant="icon"
                              className="danger"
                              icon="trash"
                              disabled={upload.isPending}
                              onClick={() => setDeletingDay(day)}
                              title={`刪除 ${day.businessDate} 預覽資料`}
                              aria-label={`刪除 ${day.businessDate} 預覽資料`}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button
                disabled={!scopeName || upload.isPending}
                loading={upload.isPending}
                loadingLabel="匯入中…"
                onClick={submit}
              >
                {scopeName ? `匯入到「${scopeName}」` : "請先選擇據點"}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}
      </div>
      </details>
      {addingDay ? (
        <ManualPayoutPreviewDialog
          key="new-preview-day"
          day={null}
          existingDates={new Set(previewDays.map((day) => day.businessDate))}
          onClose={() => setAddingDay(false)}
          onSave={addPreviewDay}
        />
      ) : null}
      {editingDay ? (
        <ManualPayoutPreviewDialog
          key={editingDay.businessDate}
          day={editingDay}
          existingDates={new Set(previewDays
            .filter((day) => day.businessDate !== editingDay.businessDate)
            .map((day) => day.businessDate))}
          onClose={() => setEditingDay(null)}
          onSave={savePreviewDay}
        />
      ) : null}
      {deletingDay ? (
        <ConfirmDialog
          title="從預覽刪除這筆資料？"
          confirmLabel="刪除資料"
          onCancel={() => setDeletingDay(null)}
          onConfirm={deletePreviewDay}
        >
          <p>
            <strong>{deletingDay.businessDate}</strong> 的出金金額 {deletingDay.payoutAmount.toLocaleString("zh-TW")} 會從這次匯入預覽移除。
          </p>
          <p className="muted">刪除只會影響這次預覽；按下「匯入」後，這一天才不會送出。</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
