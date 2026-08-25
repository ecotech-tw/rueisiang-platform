import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import {
  useCloseSandboxSession,
  useCreateSandboxSession,
  useRunSandbox,
  useSandboxConfig,
  useSandboxSession,
  useSandboxSessions,
  useSaveAssistantModel,
  useSavePrompt,
  useUploadSandboxAttachment,
  AssistantApiError,
  type SandboxToolCall,
  type PromptRevision,
  type SandboxAttachment,
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
  const savePrompt = useSavePrompt();
  const run = useRunSandbox();
  const sessions = useSandboxSessions();
  const createSession = useCreateSandboxSession();
  const closeSession = useCloseSandboxSession();
  const uploadAttachment = useUploadSandboxAttachment();
  const [model, setModel] = useState("");
  const [promptId, setPromptId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("台北現在的天氣如何？");
  const [toolKeys, setToolKeys] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<SandboxAttachment[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [failedRun, setFailedRun] = useState<{ runId?: string; toolCalls: SandboxToolCall[] } | null>(null);
  const session = useSandboxSession(sessionId);

  useEffect(() => {
    if (!config.data) return;
    setModel((current) => current || config.data.activeModel);
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

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><Alert tone="danger">{config.error.message}</Alert></div>;

  const data = config.data;
  if (!data) return null;
  const activeRevision = data.revisions.find((revision) => revision.id === promptId);
  const selectedModel = data.models.find((item) => item.id === model);
  const codexModels = data.models.filter((item) => item.provider === "openai-codex");
  const geminiModels = data.models.filter((item) => item.provider === "google");
  const modelReady = Boolean(selectedModel?.supported && selectedModel.configured);
  const currentSession = session.data?.session;
  const sessionOpen = currentSession?.status === "open";

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
    if (!model || model === data.activeModel) return;
    saveModel.mutate(model);
  }

  function submitRun() {
    const submittedInput = input.trim();
    const submittedAttachments = attachments;
    if (!promptId || !modelReady || (!submittedInput && !submittedAttachments.length) || !sessionId || !sessionOpen) return;
    setInput("");
    setAttachments([]);
    setFailedRun(null);
    run.mutate(
      { sessionId, model, promptRevisionId: promptId, toolKeys, input: submittedInput, attachments: submittedAttachments },
      {
        onError: (error) => {
          setInput(submittedInput);
          setAttachments(submittedAttachments);
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
      onSuccess: ({ session: created }) => {
        setSessionId(created.id);
      },
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

      {!data.providers.codex ? (
        <Alert tone="danger">尚未完成 ChatGPT／Codex OAuth credential 設定，GPT 模型目前不可執行。</Alert>
      ) : null}
      {!data.providers.gemini ? (
        <Alert tone="danger">尚未設定 GEMINI_API_KEY，Gemini 模型目前不可執行。</Alert>
      ) : null}

      <div className="assistant-sandbox-layout">
        <div className="assistant-settings-column">
          <Panel title="執行設定" className="assistant-settings-panel">
            <div className="field-grid">
              <label className="field">
                <span>Pi 模型</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <optgroup label="GPT / Codex（ChatGPT OAuth）">
                    {codexModels.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.supported || !item.configured}>
                        {item.label}{item.supported && item.configured ? "" : "（目前不可用）"}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Gemini（API key）">
                    {geminiModels.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.supported || !item.configured}>
                        {item.label}{item.supported && item.configured ? "" : "（目前不可用）"}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <small>{selectedModel?.note ?? "GPT 使用 ChatGPT OAuth；Gemini 使用 Cloudflare secret 裡的 API key。"}</small>
                {selectedModel?.supportsVision ? <small>此模型支援圖片輸入，可在下方附加 JPEG、PNG、WebP 或 GIF。</small> : null}
                <small>目前小香正式使用：{data.models.find((item) => item.id === data.activeModel)?.label ?? data.activeModel}</small>
                {!sessionId ? <small>尚未選擇 session，建立新 session 時會使用目前小香的 active model 與 active revision。</small> : null}
                {sessionOpen ? <small>目前 session 可直接切換模型；下一次送出時會套用選取的模型。</small> : null}
                <div className="assistant-actions">
                  <Button
                    disabled={!modelReady || model === data.activeModel || saveModel.isPending}
                    onClick={submitModel}
                  >
                    {saveModel.isPending ? "套用中…" : "儲存並套用到小香"}
                  </Button>
                  {saveModel.isSuccess ? <span className="form-hint">已更新，小香之後會使用這個模型。</span> : null}
                  {saveModel.error ? <Alert tone="danger">{saveModel.error.message}</Alert> : null}
                </div>
              </label>
            </div>

            <div className="assistant-subsection">
              <div className="assistant-subsection-head">
                <div>
                  <h3>可調用的 tools</h3>
                  <p className="muted">Sandbox 可測試「開發中」與「已啟用」；停用工具不會送給模型。</p>
                </div>
                <Button variant="secondary" icon="widgets" className="assistant-tool-config-button" onClick={() => setToolsOpen(true)}>
                  設定 tools
                  <span className="assistant-tool-count">{toolKeys.length}</span>
                </Button>
              </div>
              <div className="assistant-selection-summary">
                {toolKeys.length
                  ? data.tools.filter((tool) => toolKeys.includes(tool.key)).map((tool) => (
                    <span className="status status-active" key={tool.key}>{tool.label}</span>
                  ))
                  : <span className="muted">尚未選擇 tools</span>}
              </div>
            </div>

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
                <Button disabled={!prompt.trim() || savePrompt.isPending} onClick={submitPrompt}>
                  {savePrompt.isPending ? "儲存中…" : "儲存新 revision"}
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
            <select
              className="assistant-session-select"
              aria-label="選擇 Sandbox session"
              value={sessionId}
              onChange={(event) => {
                setSessionId(event.target.value);
              }}
            >
              <option value="">選擇 session</option>
              {(sessions.data?.sessions ?? []).map((item) => (
                <option value={item.id} key={item.id}>
                  {item.status === "open" ? "進行中" : "已關閉"} · {formatDate(item.createdAt)}
                </option>
              ))}
            </select>
            <Button variant="secondary" disabled={!modelReady || !promptId || createSession.isPending || closeSession.isPending} onClick={clearConversation}>
              {createSession.isPending || closeSession.isPending ? "清除中…" : "清除對話"}
            </Button>
          </div>
        </div>
        {createSession.error ? <Alert tone="danger">{createSession.error.message}</Alert> : null}
        {closeSession.error ? <Alert tone="danger">{closeSession.error.message}</Alert> : null}
        {session.error ? <Alert tone="danger">{session.error.message}</Alert> : null}
        <div className="assistant-conversation" aria-live="polite">
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
            )) : <p className="empty-state">這個 session 還沒有訊息。</p>
          ) : <p className="empty-state">請按「清除對話」建立一個新的 session。</p>}
        </div>
        {failedRun?.toolCalls.length ? (
          <div className="assistant-failed-run">
            <details className="assistant-message-tools">
              <summary>本次失敗前的工具調用（{failedRun.toolCalls.length}）</summary>
              <ToolCallList calls={failedRun.toolCalls} />
            </details>
          </div>
        ) : null}
        <label className="field">
          <span>輸入內容</span>
          <div className="assistant-attachment-picker">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={!sessionOpen || run.isPending || uploadAttachment.isPending || !selectedModel?.supportsVision}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                selectAttachment(file);
              }}
            />
            <span>{uploadAttachment.isPending ? "圖片上傳中…" : "附加圖片"}</span>
            {!selectedModel?.supportsVision ? <small>目前模型不支援圖片輸入</small> : null}
          </div>
          {attachments.length ? (
            <div className="assistant-pending-attachments">
              {attachments.map((attachment) => (
                <button type="button" key={attachment.key} onClick={() => setAttachments((current) => current.filter((item) => item.key !== attachment.key))}>
                  {attachment.filename} ×
                </button>
              ))}
            </div>
          ) : null}
          <div className="assistant-input-wrap">
            <textarea
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
            <span className="assistant-input-shortcut">Shift + Enter 送出</span>
          </div>
        </label>
        <div className="assistant-actions">
          <Button disabled={!modelReady || run.isPending || (!input.trim() && !attachments.length) || !sessionOpen} onClick={submitRun}>
            {run.isPending ? "小香思考中…" : "送出"}
          </Button>
          <span className="form-hint">
            {sessionOpen
              ? `目前使用 Revision ${activeRevision?.revision ?? "—"}、${selectedModel?.label ?? model}。`
              : "請先建立一個新的 session；關閉的 session 只能查看歷史，不能繼續對話。"}
          </span>
        </div>
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
      </Panel>
    </div>

      {revisionsOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRevisionsOpen(false);
          }}
        >
          <div className="modal-card wide assistant-modal-card" role="dialog" aria-modal="true" aria-labelledby="assistant-revision-title">
            <div className="modal-head">
              <h2 id="assistant-revision-title">Revision history</h2>
              <Button variant="icon" icon="close" onClick={() => setRevisionsOpen(false)} title="關閉" aria-label="關閉" />
            </div>
            <div className="modal-body assistant-modal-body">
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
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setRevisionsOpen(false)}>關閉</Button>
            </div>
          </div>
        </div>
      ) : null}

      {toolsOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setToolsOpen(false);
          }}
        >
          <div className="modal-card wide assistant-modal-card" role="dialog" aria-modal="true" aria-labelledby="assistant-tools-title">
            <div className="modal-head">
              <h2 id="assistant-tools-title">設定可調用的 tools</h2>
              <Button variant="icon" icon="close" onClick={() => setToolsOpen(false)} title="關閉" aria-label="關閉" />
            </div>
            <div className="modal-body assistant-modal-body">
              <p className="muted">勾選後會在下一次 Sandbox 執行時送給模型；「開發中」工具只可在 Sandbox 使用。</p>
              <div className="assistant-tool-list">
                {data.tools.map((tool) => (
                  <label className="assistant-tool" key={tool.key}>
                    <span className="assistant-tool-control">
                      <input
                        type="checkbox"
                        checked={toolKeys.includes(tool.key)}
                        disabled={tool.status === "disabled"}
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
            </div>
            <div className="modal-actions">
              <Button onClick={() => setToolsOpen(false)}>完成</Button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
