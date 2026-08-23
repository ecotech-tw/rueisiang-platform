import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import {
  useCloseSandboxSession,
  useCreateSandboxSession,
  useRunSandbox,
  useSandboxConfig,
  useSandboxSession,
  useSandboxSessions,
  useSaveAssistantModel,
  useSavePrompt,
  AssistantApiError,
  type SandboxToolCall,
  type PromptRevision,
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
  const [model, setModel] = useState("");
  const [promptId, setPromptId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("台北現在的天氣如何？");
  const [toolKeys, setToolKeys] = useState<string[]>([]);
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
  if (config.error) return <div className="page"><p className="form-error" role="alert">{config.error.message}</p></div>;

  const data = config.data;
  if (!data) return null;
  const activeRevision = data.revisions.find((revision) => revision.id === promptId);
  const selectedModel = data.models.find((item) => item.id === model);
  const codexModels = data.models.filter((item) => item.provider === "openai-codex");
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
    if (!promptId || !modelReady || !submittedInput || !sessionId || !sessionOpen) return;
    setInput("");
    setFailedRun(null);
    run.mutate(
      { sessionId, model, promptRevisionId: promptId, toolKeys, input: submittedInput },
      {
        onError: (error) => {
          setInput(submittedInput);
          if (error instanceof AssistantApiError && error.toolCalls.length) {
            setFailedRun({ runId: error.runId, toolCalls: error.toolCalls });
          }
        },
      },
    );
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
      <header className="page-head">
        <h1>小香助理 Sandbox</h1>
        <p className="muted">在接上 LINE 前，先用同一套 prompt、模型與工具執行流程測試回答品質。</p>
      </header>

      {!data.providers.codex ? (
        <p className="form-error" role="alert">尚未完成 ChatGPT／Codex OAuth credential 設定，GPT 模型目前不可執行。</p>
      ) : null}

      <div className="assistant-sandbox-layout">
        <div className="assistant-settings-column">
          <section className="panel assistant-settings-panel">
            <h2 className="panel-title">執行設定</h2>
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
                </select>
                <small>{selectedModel?.note ?? "由 Pi Agent 透過 ChatGPT OAuth 使用 Codex。"}</small>
                {selectedModel?.supportsVision ? <small>此模型支援圖片輸入；上傳介面會在 vision PR 加入。</small> : null}
                <small>目前小香正式使用：{data.models.find((item) => item.id === data.activeModel)?.label ?? data.activeModel}</small>
                {!sessionId ? <small>尚未選擇 session，建立新 session 時會使用目前小香的 active model 與 active revision。</small> : null}
                {sessionOpen ? <small>目前 session 可直接切換模型；下一次送出時會套用選取的模型。</small> : null}
                <div className="assistant-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!modelReady || model === data.activeModel || saveModel.isPending}
                    onClick={submitModel}
                  >
                    {saveModel.isPending ? "套用中…" : "儲存並套用到小香"}
                  </button>
                  {saveModel.isSuccess ? <span className="form-hint">已更新，小香之後會使用這個模型。</span> : null}
                  {saveModel.error ? <span className="form-error">{saveModel.error.message}</span> : null}
                </div>
              </label>
            </div>

            <div className="assistant-subsection">
              <div className="assistant-subsection-head">
                <div>
                  <h3>可調用的 tools</h3>
                  <p className="muted">Sandbox 可測試「開發中」與「已啟用」；停用工具不會送給模型。</p>
                </div>
                <button type="button" className="assistant-tool-config-button" onClick={() => setToolsOpen(true)}>
                  <Icon name="widgets" />
                  設定 tools
                  <span className="assistant-tool-count">{toolKeys.length}</span>
                </button>
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
                <button type="button" className="primary-button" disabled={!prompt.trim() || savePrompt.isPending} onClick={submitPrompt}>
                  {savePrompt.isPending ? "儲存中…" : "儲存新 revision"}
                </button>
                <button type="button" className="ghost-button" onClick={() => setRevisionsOpen(true)}>
                  Revision history
                </button>
                {savePrompt.error ? <span className="form-error">{savePrompt.error.message}</span> : null}
                {savePrompt.isSuccess ? <span className="form-hint">已儲存並套用。</span> : null}
              </div>
            </div>
          </section>
        </div>

      <section className="panel assistant-chat-panel">
        <h2 className="panel-title">測試對話</h2>
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
            <button type="button" className="ghost-button" disabled={!modelReady || !promptId || createSession.isPending || closeSession.isPending} onClick={clearConversation}>
              {createSession.isPending || closeSession.isPending ? "清除中…" : "清除對話"}
            </button>
          </div>
        </div>
        {createSession.error ? <p className="form-error" role="alert">{createSession.error.message}</p> : null}
        {closeSession.error ? <p className="form-error" role="alert">{closeSession.error.message}</p> : null}
        {session.error ? <p className="form-error" role="alert">{session.error.message}</p> : null}
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
          <button type="button" className="primary-button" disabled={!modelReady || run.isPending || !input.trim() || !sessionOpen} onClick={submitRun}>
            {run.isPending ? "小香思考中…" : "送出"}
          </button>
          <span className="form-hint">
            {sessionOpen
              ? `目前使用 Revision ${activeRevision?.revision ?? "—"}、${selectedModel?.label ?? model}。`
              : "請先建立一個新的 session；關閉的 session 只能查看歷史，不能繼續對話。"}
          </span>
        </div>
        {run.error ? <p className="form-error" role="alert">{run.error.message}</p> : null}
      </section>
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
              <button type="button" className="icon-button" onClick={() => setRevisionsOpen(false)} title="關閉" aria-label="關閉">
                <Icon name="close" />
              </button>
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
              <button type="button" className="ghost-button" onClick={() => setRevisionsOpen(false)}>關閉</button>
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
              <button type="button" className="icon-button" onClick={() => setToolsOpen(false)} title="關閉" aria-label="關閉">
                <Icon name="close" />
              </button>
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
              <button type="button" className="primary-button" onClick={() => setToolsOpen(false)}>完成</button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
