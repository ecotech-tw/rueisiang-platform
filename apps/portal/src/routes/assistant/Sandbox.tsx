import { useEffect, useRef, useState } from "react";
import { HrImpersonation } from "./HrImpersonation.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, ButtonSkin, Dialog, DropdownSelect, EmptyState, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
import {
  useCloseSandboxSession,
  useCreateSandboxSession,
  useRunSandbox,
  useSandboxConfig,
  useSandboxSession,
  useSandboxSessions,
  useSaveAssistantModel,
  useSaveAssistantFallbackModel,
  useSavePrompt,
  useUploadSandboxAttachment,
  AssistantApiError,
  type SandboxToolCall,
  type PromptRevision,
  type SandboxAttachment,
  type HrSandboxEmployee,
} from "./api.js";

function formatDate(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW", { hour12: false });
}

function formatToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    return "無法顯示參數。";
  }
}

function ToolCallList({ calls }: { calls: SandboxToolCall[] }) {
  return (
    <div className="assistant-tool-call-list">
      {calls.map((call, index) => (
        <div className="assistant-tool-call" key={`${call.toolKey}-${index}`}>
          <div className="assistant-tool-call-meta">
            <strong>{call.toolKey}</strong>
            <small className={call.status === "success" ? "assistant-tool-call-success" : "assistant-tool-call-failure"}>
              {call.status === "success" ? "成功" : "失敗"} · {call.durationMs} ms
            </small>
          </div>
          {call.args ? (
            <details className="assistant-tool-call-args">
              <summary>調用參數</summary>
              <pre>{formatToolArgs(call.args)}</pre>
            </details>
          ) : null}
          {call.errorMessage ? <small className="assistant-tool-call-error">{call.errorMessage}</small> : null}
        </div>
      ))}
    </div>
  );
}

function statusLabel(status: "enabled" | "development" | "disabled"): string {
  if (status === "enabled") return "已啟用";
  if (status === "development") return "開發中";
  return "已停用";
}

export function Sandbox() {
  usePageTitle("小香助理 Sandbox");
  const config = useSandboxConfig();
  const saveModel = useSaveAssistantModel();
  const saveFallbackModel = useSaveAssistantFallbackModel();
  const savePrompt = useSavePrompt();
  const run = useRunSandbox();
  const sessions = useSandboxSessions();
  const createSession = useCreateSandboxSession();
  const closeSession = useCloseSandboxSession();
  const uploadAttachment = useUploadSandboxAttachment();
  const [model, setModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [promptId, setPromptId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("台北現在的天氣如何？");
  const [toolKeys, setToolKeys] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<SandboxAttachment[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [employee, setEmployee] = useState<HrSandboxEmployee | null>(null);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [failedRun, setFailedRun] = useState<{ runId?: string; toolCalls: SandboxToolCall[] } | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const session = useSandboxSession(sessionId);

  useEffect(() => {
    if (!config.data) return;
    setModel((current) => current || config.data.activeModel);
    setFallbackModel((current) => current || config.data.fallbackModel || "");
    setPromptId((current) => current || config.data.activePrompt?.id || "");
    setPrompt((current) => current || config.data.activePrompt?.systemPrompt || "");
    const availableToolKeys = new Set(config.data.tools.map((tool) => tool.key));
    setToolKeys((current) => current.length
      ? current.filter((key) => availableToolKeys.has(key))
      : config.data.tools.filter((tool) => tool.status !== "disabled").map((tool) => tool.key));
  }, [config.data]);

  useEffect(() => {
    const current = session.data?.session;
    if (!current || current.id !== sessionId || !config.data) return;
    setModel(current.model);
    const revision = config.data.revisions.find((item) => item.id === current.promptRevisionId);
    if (revision) {
      setPromptId(revision.id);
      setPrompt(revision.systemPrompt);
    }
    // Only load server state when switching sessions. Config invalidations caused by
    // saving a prompt/tool/model must not overwrite the user's current editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session.data?.session?.id]);

  // 送出會先寫入 optimistic user message，回覆完成後再重抓 session；兩個時機都要貼到底。
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
  }, [sessionId, session.data?.session?.messages.length, run.isPending, pendingSessionId, failedRun?.runId]);

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><Alert tone="danger">{config.error.message}</Alert></div>;

  const data = config.data;
  if (!data) return null;
  const activeRevision = data.revisions.find((revision) => revision.id === promptId);
  const selectedModel = data.models.find((item) => item.id === model);
  const selectedFallbackModel = data.models.find((item) => item.id === fallbackModel);
  const codexModels = data.models.filter((item) => item.provider === "openai-codex");
  const geminiModels = data.models.filter((item) => item.provider === "google");
  const modelOptions = [
    ...codexModels.map((item) => ({ label: `GPT / Codex：${item.label}${item.supported && item.configured ? "" : "（目前不可用）"}`, value: item.id, disabled: !item.supported || !item.configured })),
    ...geminiModels.map((item) => ({ label: `Gemini：${item.label}${item.supported && item.configured ? "" : "（目前不可用）"}`, value: item.id, disabled: !item.supported || !item.configured })),
  ];
  const fallbackOptions = [{ label: "不使用 fallback", value: "" }, ...modelOptions];
  const modelReady = Boolean(selectedModel?.supported && selectedModel.configured);
  const fallbackReady = !fallbackModel || Boolean(selectedFallbackModel?.supported && selectedFallbackModel.configured);
  // 顯示值可能已回落／暫停，但 DB 仍保留退役設定；允許管理者明確確認同值或清除。
  const canSaveModel = modelReady && model !== fallbackModel
    && (model !== data.activeModel || data.activeModelNeedsSave === true);
  const canSaveFallbackModel = fallbackReady
    && (!fallbackModel || (fallbackModel !== data.activeModel && fallbackModel !== model))
    && (fallbackModel !== (data.fallbackModel ?? "") || data.fallbackModelNeedsSave === true);
  const currentSession = session.data?.session;
  const sessionOpen = currentSession?.status === "open";
  // HR 工具要「有模擬對象、綁定設好、授權工具沒停用」三件都成立才送得出去；
  // 少一件就整組不送，勾選狀態留著，條件齊了自動生效。只擋其中一個的話送出鈕會卡死在使用者解不開的狀態。
  const hrToolKeys = new Set(data.hrSandbox.toolKeys);
  const hrAuthorizeStatus = data.tools.find((tool) => tool.key === "hr_authorize")?.status ?? "disabled";
  const hrAuthorizeDisabled = hrToolKeys.size > 0 && hrAuthorizeStatus === "disabled";
  const hrToolsUsable = Boolean(employee) && data.hrSandbox.bindingConfigured && !hrAuthorizeDisabled;
  const activeToolKeys = toolKeys.filter((key) => hrToolsUsable || !hrToolKeys.has(key));
  const hrAuthorizeMissing = activeToolKeys.some((key) => hrToolKeys.has(key)) && !activeToolKeys.includes("hr_authorize");

  // 模擬對象跟著對話走：留著的話，切到別的 session 送出時會把這位員工的資料帶進一段不相干的對話。
  function selectSession(id: string) {
    setSessionId(id);
    setEmployee(null);
  }

  function selectRevision(revision: PromptRevision) {
    setPromptId(revision.id);
    setPrompt(revision.systemPrompt);
  }

  function toggleTool(key: string) {
    setToolKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function submitPrompt() {
    savePrompt.mutate(prompt, {
      onSuccess: ({ revision }) => {
        setPromptId(revision.id);
      },
    });
  }

  function submitModel() {
    if (!canSaveModel) return;
    saveModel.mutate(model);
  }

  function submitFallbackModel() {
    if (!canSaveFallbackModel) return;
    saveFallbackModel.mutate(fallbackModel || null, {
      onSuccess: (result) => setFallbackModel(result.fallbackModel ?? ""),
    });
  }

  function submitRun() {
    const submittedInput = input.trim();
    const submittedAttachments = attachments;
    if (!promptId || !modelReady || hrAuthorizeMissing || (!submittedInput && !submittedAttachments.length) || !sessionId || !sessionOpen || uploadAttachment.isPending) return;
    setPendingSessionId(sessionId);
    setFailedRun(null);
    run.mutate(
      {
        sessionId, model, promptRevisionId: promptId, toolKeys: activeToolKeys, input: submittedInput, attachments: submittedAttachments,
        ...(employee ? { hrSandboxUserId: employee.userId } : {}),
      },
      {
        onSuccess: () => {
          setPendingSessionId(null);
          setInput("");
          setAttachments([]);
        },
        onError: (error) => {
          setPendingSessionId(null);
          if (error instanceof AssistantApiError && error.toolCalls.length) {
            setFailedRun({ runId: error.runId, toolCalls: error.toolCalls });
          }
        },
      },
    );
  }

  function selectAttachment(file: File | undefined) {
    if (!file) return;
    if (!selectedModel?.supportsVision) {
      uploadAttachment.reset();
      return;
    }
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
      uploadAttachment.reset();
      return;
    }
    uploadAttachment.mutate({ file, chatId: sessionId }, {
      onSuccess: ({ attachment }) => setAttachments((current) => [...current, attachment].slice(0, 4)),
    });
  }

  function createFreshSession() {
    if (!modelReady || !promptId) return;
    createSession.mutate({ model, promptRevisionId: promptId }, {
      onSuccess: ({ session: created }) => selectSession(created.id),
    });
  }

  function clearConversation() {
    if (!sessionId || !sessionOpen) {
      createFreshSession();
      return;
    }
    closeSession.mutate(sessionId, { onSuccess: createFreshSession });
  }

  return (
    <div className="page assistant-sandbox-page">
      <PageHeader
        title="小香助理 Sandbox"
        description="在接上 LINE 前，先用同一套 prompt、模型與工具執行流程測試回答品質。"
      />

      {data.modelNotice ? <Alert tone="danger">{data.modelNotice}</Alert> : null}
      {!data.providers.codex ? (
        <Alert tone="danger">尚未完成 ChatGPT／Codex OAuth credential 設定，GPT 模型目前不可執行。</Alert>
      ) : null}
      {!data.providers.gemini ? (
        <Alert tone="danger">尚未設定 GEMINI_API_KEY，Gemini 模型目前不可執行。</Alert>
      ) : null}
      {data.credentialStatus.codex === "needs_reauth" ? (
        <Alert tone="danger">ChatGPT／Codex OAuth 更新 token 時回傳 401；請重新執行 codex login 並更新平台 credential。若已設定 fallback，請求會先嘗試備援模型。</Alert>
      ) : null}

      <div className="assistant-sandbox-layout">
        <div className="assistant-settings-column">
          <Panel title="執行設定" className="assistant-settings-panel">
            <div className="field-grid">
              <label className="field">
                <span>Pi 模型</span>
                <DropdownSelect options={modelOptions} value={model} onChange={(event) => setModel(event.target.value)} aria-label="Pi 模型" />
                <small>{selectedModel?.note ?? "GPT 使用 ChatGPT OAuth；Gemini 使用 Cloudflare secret 裡的 API key。"}</small>
                <small>模型清單來自安裝的 Pi catalog；選擇模型只影響測試，按「儲存並套用到小香」才會更新正式設定。</small>
                {selectedModel?.supportsVision ? <small>此模型支援圖片輸入，可在下方附加 JPEG、PNG、WebP 或 GIF。</small> : null}
                <small>目前小香正式使用：{data.models.find((item) => item.id === data.activeModel)?.label ?? data.activeModel}</small>
                {!sessionId ? <small>尚未選擇 session，建立新 session 時會使用目前小香的 active model 與 active revision。</small> : null}
                {sessionOpen ? <small>目前 session 可直接切換模型；下一次送出時會套用選取的模型。</small> : null}
                <div className="assistant-actions">
                  <Button
                    loading={saveModel.isPending}
                    loadingLabel="套用中…"
                    disabled={!canSaveModel}
                    onClick={submitModel}
                  >
                    儲存並套用到小香
                  </Button>
                  {saveModel.isSuccess ? <span className="form-hint">已更新，小香之後會使用這個模型。</span> : null}
                  {saveModel.error ? <Alert tone="danger">{saveModel.error.message}</Alert> : null}
                </div>
              </label>
              <label className="field">
                <span>模型失敗時的 fallback</span>
                <DropdownSelect options={fallbackOptions} value={fallbackModel} onChange={(event) => setFallbackModel(event.target.value)} aria-label="模型失敗時的 fallback" />
                <small>主要模型回傳 error 時，這一輪會改用選定的模型重試；不會固定綁死 Gemini。</small>
                {selectedFallbackModel?.supportsVision ? <small>此 fallback 支援圖片輸入。</small> : null}
                {fallbackModel === data.activeModel || fallbackModel === model ? <small>fallback 不能與選取中的 active model 相同。</small> : null}
                <div className="assistant-actions">
                  <Button
                    loading={saveFallbackModel.isPending}
                    loadingLabel="儲存中…"
                    disabled={!canSaveFallbackModel}
                    onClick={submitFallbackModel}
                  >
                    儲存 fallback 設定
                  </Button>
                  {saveFallbackModel.isSuccess ? <span className="form-hint">fallback 設定已更新。</span> : null}
                  {saveFallbackModel.error ? <Alert tone="danger">{saveFallbackModel.error.message}</Alert> : null}
                </div>
              </label>
            </div>

            <div className="assistant-subsection">
              <div className="assistant-subsection-head">
                <div>
                  <h3>可調用的 tools</h3>
                  <p className="muted">Sandbox 可測試「開發中」與「已啟用」；停用工具不會送給模型。</p>
                </div>
                <ButtonSkin skin="paper">
                  <Button variant="secondary" icon="widgets" className="flex-none" onClick={() => setToolsOpen(true)}>
                    設定 tools
                    <span className="assistant-tool-count">{activeToolKeys.length}</span>
                  </Button>
                </ButtonSkin>
              </div>
              <div className="assistant-selection-summary">
                {activeToolKeys.length
                  ? data.tools.filter((tool) => activeToolKeys.includes(tool.key)).map((tool) => (
                    <span className="status status-active" key={tool.key}>{tool.label}</span>
                  ))
                  : <span className="muted">尚未選擇 tools</span>}
              </div>
              {hrAuthorizeMissing ? <Alert tone="danger">HR 查詢工具要連同「hr_authorize」一起勾選才能送出。</Alert> : null}
              {employee && hrAuthorizeDisabled ? <Alert tone="danger">「hr_authorize」目前已停用，這一輪不會送出 HR 工具；請先到小香設定頁啟用。</Alert> : null}
            </div>

            {data.hrSandbox.available ? (
              <HrImpersonation
                employee={employee}
                bindingConfigured={data.hrSandbox.bindingConfigured}
                disabled={run.isPending}
                onChange={setEmployee}
              />
            ) : null}

            <div className="assistant-subsection assistant-prompt-section">
              <div className="assistant-subsection-head">
                <div>
                  <h3>System prompt</h3>
                  <p className="muted">目前 Revision {activeRevision?.revision ?? "—"}；儲存後會立即套用。</p>
                </div>
                <span className="status status-active">編輯中</span>
              </div>
              <label className="field">
                <span>目前編輯內容</span>
                <textarea className="assistant-textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                <small>儲存後會建立新的 revision，並立即成為之後執行與未來 LINE channel 的 active prompt。</small>
              </label>
              <div className="assistant-actions">
                <Button loading={savePrompt.isPending} loadingLabel="儲存中…" disabled={!prompt.trim()} onClick={submitPrompt}>
                  儲存新 revision
                </Button>
                <Button variant="secondary" onClick={() => setRevisionsOpen(true)}>
                  Revision history
                </Button>
                {savePrompt.error ? <Alert tone="danger">{savePrompt.error.message}</Alert> : null}
                {savePrompt.isSuccess ? <span className="form-hint">已儲存並套用。</span> : null}
              </div>
            </div>
          </Panel>
        </div>

      <Panel title="測試對話" className="assistant-chat-panel">
        <div className="assistant-session-bar">
          <div className="assistant-session-copy">
            <strong>Sandbox session</strong>
            <span>
              {currentSession
                ? `${currentSession.status === "open" ? "進行中" : "已關閉"} · ${formatDate(currentSession.updatedAt)}`
                : "尚未建立 session；建立後每一輪會保留在同一段對話中。"}
            </span>
          </div>
          <div className="assistant-session-actions">
            <FilterSelect
              className="assistant-session-select"
              label="選擇 Sandbox session"
              value={sessionId}
              onChange={(event) => selectSession(event.target.value)}
              options={[
                { value: "", label: "選擇 session" },
                ...(sessions.data?.sessions ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.status === "open" ? "進行中" : "已關閉"} · ${formatDate(item.createdAt)}`,
                })),
              ]}
            />
            <Button
              variant="secondary"
              loading={createSession.isPending || closeSession.isPending}
              loadingLabel="清除中…"
              disabled={!modelReady || !promptId}
              onClick={clearConversation}
            >
              清除對話
            </Button>
          </div>
        </div>
        {createSession.error ? <Alert tone="danger">{createSession.error.message}</Alert> : null}
        {closeSession.error ? <Alert tone="danger">{closeSession.error.message}</Alert> : null}
        {session.error ? <Alert tone="danger">{session.error.message}</Alert> : null}
        <div ref={conversationRef} className="assistant-conversation" aria-live="polite">
          {currentSession ? (
            currentSession.messages.length ? currentSession.messages.map((message) => (
              <div className={`assistant-message ${message.role === "user" ? "assistant-message-user" : "assistant-message-model"}`} key={message.id}>
                <div className="assistant-message-meta">
                  <strong>{message.role === "user" ? "你" : "小香"}</strong>
                    <small>
                      {formatDate(message.createdAt)}
                      {message.model ? ` · ${data.models.find((item) => item.id === message.model)?.label ?? message.model}` : ""}
                    </small>
                </div>
                <pre>{message.text}</pre>
                {message.role === "model" && message.thoughts ? (
                  <details className="assistant-message-thoughts">
                    <summary>thinking / reasoning</summary>
                    <pre>{message.thoughts}</pre>
                  </details>
                ) : null}
                {message.role === "model" && message.toolCalls.length ? (
                  <details className="assistant-message-tools">
                    <summary>工具調用（{message.toolCalls.length}）</summary>
                    <ToolCallList calls={message.toolCalls} />
                  </details>
                ) : null}
                {message.attachments?.length ? (
                  <div className="assistant-message-attachments">
                    {message.attachments.map((attachment) => (
                      <img
                        key={attachment.key}
                        src={`/api/assistant/sandbox/attachments?key=${encodeURIComponent(attachment.key)}`}
                        alt={attachment.filename}
                        loading="lazy"
                      />
                    ))}
                  </div>
                ) : null}
                {message.role === "model" ? (
                  <small className="assistant-message-duration">本次總耗時 · {message.durationMs.toLocaleString()} ms</small>
                ) : null}
              </div>
            )) : <EmptyState className="mt-[18px]">這個 session 還沒有訊息。</EmptyState>
          ) : <EmptyState className="mt-[18px]">請按「清除對話」建立一個新的 session。</EmptyState>}
          {run.isPending && pendingSessionId === sessionId ? (
            <div className="assistant-message assistant-message-model assistant-message-pending" role="status" aria-label="小香正在回覆">
              <div className="assistant-message-meta">
                <strong>小香</strong>
                <small>回覆中…</small>
              </div>
              <span className="assistant-typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : null}
        </div>
        {run.data?.hrRequestDraft && run.data.sessionId === sessionId ? (
          <div className="assistant-request-card">
            <div className="assistant-request-card-head">
              <strong>確認卡片預覽</strong>
              <small>LINE 上員工會收到這張卡片與按鈕；Sandbox 只預覽，不會送出。</small>
            </div>
            <pre>{run.data.hrRequestDraft.card}</pre>
            <div className="assistant-actions">
              <Button disabled>確認送出</Button>
              <Button variant="secondary" disabled>取消</Button>
            </div>
          </div>
        ) : null}
        {failedRun?.toolCalls.length ? (
          <div className="assistant-failed-run">
            <details className="assistant-message-tools">
              <summary>本次失敗前的工具調用（{failedRun.toolCalls.length}）</summary>
              <ToolCallList calls={failedRun.toolCalls} />
            </details>
          </div>
        ) : null}
        <div className="field assistant-composer-field">
          <span>輸入內容</span>
          {attachments.length ? (
            <div className="assistant-pending-attachments">
              {attachments.map((attachment) => (
                <button
                  type="button"
                  key={attachment.key}
                  disabled={run.isPending}
                  onClick={() => setAttachments((current) => current.filter((item) => item.key !== attachment.key))}
                >
                  {attachment.filename} ×
                </button>
              ))}
            </div>
          ) : null}
          <div className="assistant-input-wrap">
            <input
              ref={attachmentInputRef}
              className="assistant-attachment-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={!sessionOpen || run.isPending || uploadAttachment.isPending || !selectedModel?.supportsVision}
              aria-label="附加圖片"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                selectAttachment(file);
              }}
            />
            <textarea
              aria-label="輸入內容"
              className="assistant-input"
              value={input}
              disabled={!sessionOpen || run.isPending}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (!event.nativeEvent.isComposing && event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  submitRun();
                }
              }}
              placeholder="輸入要交給小香的問題…"
            />
            <div className="assistant-composer-actions">
              <Button
                variant="icon"
                icon="attachment"
                className="flex-none"
                disabled={!sessionOpen || run.isPending || uploadAttachment.isPending || !selectedModel?.supportsVision}
                title={uploadAttachment.isPending ? "圖片上傳中…" : "附加圖片"}
                aria-label={uploadAttachment.isPending ? "圖片上傳中" : "附加圖片"}
                onClick={() => attachmentInputRef.current?.click()}
              />
              <span className="assistant-input-shortcut">Shift + Enter 送出</span>
              <Button
                className="flex-none"
                loading={run.isPending}
                loadingLabel="小香思考中…"
                disabled={!modelReady || hrAuthorizeMissing || (!input.trim() && !attachments.length) || !sessionOpen || uploadAttachment.isPending}
                onClick={submitRun}
              >
                送出
              </Button>
            </div>
          </div>
          {!selectedModel?.supportsVision ? <small>目前模型不支援圖片輸入</small> : null}
          {uploadAttachment.isPending ? <small>圖片上傳中…</small> : null}
        </div>
        <div className="assistant-actions assistant-composer-note">
          <span className="form-hint">
            {sessionOpen
              ? `目前使用 Revision ${activeRevision?.revision ?? "—"}、${selectedModel?.label ?? model}${employee ? `，模擬 ${employee.displayName}（${employee.employeeNumber}）本人` : ""}。`
              : "請先建立一個新的 session；關閉的 session 只能查看歷史，不能繼續對話。"}
          </span>
        </div>
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
      </Panel>
    </div>

      {revisionsOpen ? (
        <Dialog
          title="Revision history"
          className="wide assistant-modal-card"
          bodyClassName="assistant-modal-body"
          onClose={() => setRevisionsOpen(false)}
          actions={<Button variant="secondary" type="button" onClick={() => setRevisionsOpen(false)}>關閉</Button>}
        >
              <p className="muted">選擇一個 revision 載入到目前的 System prompt 編輯器。</p>
              <div className="assistant-revisions">
                {data.revisions.map((revision) => (
                  <button
                    type="button"
                    className={`assistant-revision ${revision.id === promptId ? "selected" : ""}`}
                    key={revision.id}
                    onClick={() => {
                      selectRevision(revision);
                      setRevisionsOpen(false);
                    }}
                  >
                    <span>Revision {revision.revision}{revision.isActive ? " · active" : ""}</span>
                    <small>{formatDate(revision.createdAt)}</small>
                  </button>
                ))}
              </div>
        </Dialog>
      ) : null}

      {toolsOpen ? (
        <Dialog
          title="設定可調用的 tools"
          className="wide assistant-modal-card"
          bodyClassName="assistant-modal-body"
          onClose={() => setToolsOpen(false)}
          actions={<Button type="button" onClick={() => setToolsOpen(false)}>完成</Button>}
        >
              <p className="muted">
                勾選後會在下一次 Sandbox 執行時送給模型；「開發中」工具只可在 Sandbox 使用。
                {hrToolKeys.size ? "HR 工具要先在「模擬員工本人」選一位員工、平台設好 LINE Login 綁定才會生效。" : ""}
              </p>
              <div className="assistant-tool-list">
                {data.tools.map((tool) => (
                  <label className="assistant-tool" key={tool.key}>
                    <span className="assistant-tool-control">
                      <input
                        type="checkbox"
                        checked={toolKeys.includes(tool.key)}
                        disabled={tool.status === "disabled" || (hrToolKeys.has(tool.key) && !hrToolsUsable)}
                        onChange={() => toggleTool(tool.key)}
                      />
                      <Icon name="widgets" />
                    </span>
                    <span>
                      <strong>{tool.label}</strong>
                      <small>{tool.description}</small>
                      {tool.requiredPermissions.length ? <small>需要權限：{tool.requiredPermissions.join("、")}</small> : null}
                    </span>
                    <em className={`status status-${tool.status}`}>{statusLabel(tool.status)}</em>
                  </label>
                ))}
              </div>
        </Dialog>
      ) : null}

    </div>
  );
}
