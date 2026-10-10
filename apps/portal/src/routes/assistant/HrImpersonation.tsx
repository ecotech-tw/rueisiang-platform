import { useState } from "react";
import { Alert, Button, DropdownSelect } from "../../ui/index.js";
import { useHrSandboxEmployees, type HrSandboxEmployee } from "./api.js";

export function hrSandboxEmployeeLabel(employee: HrSandboxEmployee): string {
  return `${employee.displayName}（${employee.employeeNumber}）${employee.userStatus !== "active" ? " · 帳號未啟用" : ""}${employee.lineBound ? "" : " · 未綁定 LINE"}`;
}

/** Sandbox 設定欄裡的「模擬員工本人」：只負責選人，送出與工具選擇仍在 Sandbox 本體。 */
export function HrImpersonation({ employee, bindingConfigured, disabled, onChange }: {
  employee: HrSandboxEmployee | null;
  bindingConfigured: boolean;
  disabled: boolean;
  onChange: (employee: HrSandboxEmployee | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const employees = useHrSandboxEmployees(search, page);
  const listed = employees.data?.employees ?? [];
  const paged = page > 1 || Boolean(employees.data?.hasMore);

  return (
    <div className="assistant-subsection">
      <div className="assistant-subsection-head">
        <div>
          <h3>模擬員工本人</h3>
          <p className="muted">僅平台管理者可用。選了員工，HR 工具才會送給模型；不選就是一般 Sandbox。切換或清除對話會取消選取。</p>
        </div>
        {employee ? <span className="status status-active">模擬中</span> : null}
      </div>
      {/* 設定欄只有四百多 px，並排會把「姓名（編號）· 狀態」截斷，看不出選到誰。 */}
      <div className="grid gap-3">
        <label className="field">
          <span>搜尋員工</span>
          <input
            aria-label="搜尋模擬員工" value={search} maxLength={200} disabled={disabled}
            placeholder="姓名或員工編號"
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
        </label>
        <label className="field">
          <span>模擬哪位員工本人</span>
          <DropdownSelect
            aria-label="模擬員工本人" value={employee?.userId ?? ""} disabled={disabled || employees.isPending}
            onChange={(event) => onChange(listed.find((item) => item.userId === event.target.value) ?? null)}
            options={[
              { value: "", label: "不模擬" },
              // 換頁或改搜尋後，選中的員工可能不在這一頁；補回去才不會讓下拉顯示成空白。
              ...(employee && !listed.some((item) => item.userId === employee.userId)
                ? [{ value: employee.userId, label: hrSandboxEmployeeLabel(employee) }] : []),
              ...listed.map((item) => ({ value: item.userId, label: hrSandboxEmployeeLabel(item) })),
            ]}
          />
        </label>
      </div>
      {/* 說明放在兩欄外面：掛在其中一欄底下會把另一欄撐出一塊空白。 */}
      <p className="muted mt-2 text-xs">未綁定或帳號未啟用的員工可測試授權失敗；不會略過正式的綁定與在職檢查。</p>
      {paged ? (
        <div className="assistant-actions">
          <Button variant="secondary" disabled={page === 1 || disabled} onClick={() => setPage((current) => current - 1)}>上一頁</Button>
          <span className="muted text-xs">員工清單第 {page} 頁</span>
          <Button variant="secondary" disabled={!employees.data?.hasMore || disabled} onClick={() => setPage((current) => current + 1)}>下一頁</Button>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 empty:hidden">
        {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
        {employees.data && !listed.length ? <p className="empty-state">沒有符合搜尋條件的在職員工。</p> : null}
        {!bindingConfigured ? <Alert tone="danger">平台尚未設定 LINE_LIFF_CHANNEL_ID，無法驗證既有員工綁定；HR 工具不會送出，一般工具照常可用。</Alert> : null}
        {employee ? (
          <Alert>
            模擬 {employee.displayName}（{employee.employeeNumber}）本人：使用正式員工資料，會送至所選模型服務，問答與工具結果會留在你的 Sandbox session 裡；不傳送 LINE 訊息。同一段對話只能模擬一位員工，要換人請先清除對話。
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
