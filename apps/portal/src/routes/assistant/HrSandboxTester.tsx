import { useState } from "react";
import { Alert, Button, DropdownSelect, Panel } from "../../ui/index.js";
import { useHrSandboxEmployees, useRunSandbox, type HrSandboxEmployee, type SandboxConfig } from "./api.js";

export function hrSandboxEmployeeLabel(employee: HrSandboxEmployee): string {
  return `${employee.displayName}（${employee.employeeNumber}）${employee.userStatus !== "active" ? " · 帳號未啟用" : ""}${employee.lineBound ? "" : " · 未綁定 LINE"}`;
}

export function HrSandboxTester({ config, onExit }: { config: SandboxConfig; onExit: () => void }) {
  const [model, setModel] = useState(config.activeModel);
  const [promptId, setPromptId] = useState(config.activePrompt?.id ?? "");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [employee, setEmployee] = useState<HrSandboxEmployee | null>(null);
  const [input, setInput] = useState("查詢我的待審假單與當期特休剩餘額度。");
  const employees = useHrSandboxEmployees(search, page);
  const run = useRunSandbox();
  const toolKeys = config.hrSandbox.tools.filter((tool) => tool.status !== "disabled").map((tool) => tool.key);
  const ready = Boolean(config.models.find((item) => item.id === model && item.supported && item.configured));
  const canRun = ready && Boolean(employee && promptId && input.trim())
    && config.hrSandbox.bindingConfigured && toolKeys.includes("hr_authorize");

  function selectEmployee(value: string) {
    setEmployee(employees.data?.employees.find((item) => item.userId === value) ?? null);
    run.reset();
  }

  function submit() {
    if (!canRun || !employee || run.isPending) return;
    run.mutate({ model, promptRevisionId: promptId, hrSandboxUserId: employee.userId, toolKeys, input: input.trim(), attachments: [] });
  }

  return (
    <>
      <Alert>HR 模擬本人 · 僅平台管理者可用。使用正式員工資料，會送至所選模型服務；不傳送 LINE 訊息、不載入或保存對話與思考內容，僅保留操作者、目標員工、狀態與用量稽核。</Alert>
      <Panel title="HR 模擬本人測試">
        <div className="field-grid">
          <label className="field">
            <span>Pi 模型</span>
            <DropdownSelect
              aria-label="HR 測試模型" value={model} disabled={run.isPending}
              onChange={(event) => { setModel(event.target.value); run.reset(); }}
              options={config.models.map((item) => ({ value: item.id, label: item.label, disabled: !item.supported || !item.configured }))}
            />
          </label>
          <label className="field">
            <span>System prompt revision</span>
            <DropdownSelect
              aria-label="HR 測試 prompt" value={promptId} disabled={run.isPending}
              onChange={(event) => { setPromptId(event.target.value); run.reset(); }}
              options={config.revisions.map((revision) => ({ value: revision.id, label: `Revision ${revision.revision}${revision.isActive ? " · 使用中" : ""}` }))}
            />
          </label>
          <label className="field">
            <span>搜尋員工</span>
            <input
              aria-label="搜尋模擬員工" value={search} maxLength={200} disabled={run.isPending}
              placeholder="姓名或員工編號"
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            />
          </label>
          <label className="field">
            <span>模擬哪位員工本人</span>
            <DropdownSelect
              aria-label="模擬員工本人" value={employee?.userId ?? ""} disabled={run.isPending || employees.isPending}
              onChange={(event) => selectEmployee(event.target.value)}
              options={[
                { value: "", label: "請選擇員工" },
                ...(employee && !employees.data?.employees.some((item) => item.userId === employee.userId)
                  ? [{ value: employee.userId, label: hrSandboxEmployeeLabel(employee) }] : []),
                ...(employees.data?.employees ?? []).map((item) => ({
                  value: item.userId,
                  label: hrSandboxEmployeeLabel(item),
                })),
              ]}
            />
            <small>未綁定或帳號未啟用的員工可測試授權失敗；不會略過正式的綁定與在職檢查。</small>
          </label>
        </div>
        <div className="assistant-actions">
          <Button variant="secondary" disabled={page === 1 || run.isPending} onClick={() => setPage((current) => current - 1)}>上一頁</Button>
          <span className="form-hint">員工清單第 {page} 頁</span>
          <Button variant="secondary" disabled={!employees.data?.hasMore || run.isPending} onClick={() => setPage((current) => current + 1)}>下一頁</Button>
        </div>
        {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
        {employees.data && !employees.data.employees.length ? <p className="empty-state">沒有符合搜尋條件的在職員工。</p> : null}
        {!config.hrSandbox.bindingConfigured ? <Alert tone="danger">平台尚未設定 LINE_LIFF_CHANNEL_ID，無法驗證既有員工綁定。</Alert> : null}
        {!toolKeys.includes("hr_authorize") ? <Alert tone="danger">HR 本人授權工具已停用，請先由小香設定頁啟用。</Alert> : null}
        <p className="muted">每次送出都是獨立新的一輪，模型須先呼叫 hr_authorize；只提供未停用的 HR 唯讀工具，不接受圖片或切換查詢對象。</p>
        <div className="assistant-selection-summary">
          {config.hrSandbox.tools.filter((tool) => toolKeys.includes(tool.key)).map((tool) => <span className="status status-active" key={tool.key}>{tool.label}</span>)}
        </div>
        <label className="field mt-4">
          <span>測試問題{employee ? ` · 模擬 ${employee.displayName}（${employee.employeeNumber}）本人` : ""}</span>
          <textarea
            aria-label="HR 測試問題" className="assistant-textarea" value={input} maxLength={8000} disabled={run.isPending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (!event.nativeEvent.isComposing && event.shiftKey && event.key === "Enter") { event.preventDefault(); submit(); }
            }}
          />
        </label>
        <div className="assistant-actions">
          <Button disabled={!canRun} loading={run.isPending} loadingLabel="HR 測試中…" onClick={submit}>測試本人 HR 查詢</Button>
          <Button variant="secondary" disabled={run.isPending} onClick={() => { run.reset(); setInput(""); }}>清除問題與結果</Button>
          <Button variant="secondary" disabled={run.isPending} onClick={onExit}>回到一般 Sandbox</Button>
        </div>
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {run.data ? (
          <div className="assistant-message assistant-message-model mt-4" aria-live="polite">
            <div className="assistant-message-meta"><strong>小香 · HR 模擬本人測試</strong><small>本輪不留存 · {run.data.durationMs} ms</small></div>
            <pre>{run.data.text}</pre>
            <small>診斷編號：{run.data.runId}</small>
            {run.data.toolCalls.length ? (
              <details className="assistant-message-tools">
                <summary>工具執行狀態（{run.data.toolCalls.length}）</summary>
                <ul>{run.data.toolCalls.map((call, index) => <li key={`${call.toolKey}-${index}`}>{call.toolKey} · {call.status === "success" ? "成功" : "失敗"} · {call.durationMs} ms</li>)}</ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </Panel>
    </>
  );
}
