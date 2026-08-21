import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import {
  useRunSandbox,
  useSandboxConfig,
  useSaveAssistantModel,
  useSavePrompt,
  type PromptRevision,
  type SandboxResult,
} from "./api.js";

function formatDate(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW", { hour12: false });
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
  const [model, setModel] = useState("");
  const [promptId, setPromptId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("台北現在的天氣如何？");
  const [toolKeys, setToolKeys] = useState<string[]>([]);
  const [result, setResult] = useState<SandboxResult | undefined>(undefined);

  useEffect(() => {
    if (!config.data) return;
    setModel((current) => current || config.data.activeModel);
    setPromptId((current) => current || config.data.activePrompt?.id || "");
    setPrompt((current) => current || config.data.activePrompt?.systemPrompt || "");
    setToolKeys((current) => current.length ? current : config.data.tools.filter((tool) => tool.status !== "disabled").map((tool) => tool.key));
  }, [config.data]);

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><p className="form-error" role="alert">{config.error.message}</p></div>;

  const data = config.data;
  if (!data) return null;
  const activeRevision = data.revisions.find((revision) => revision.id === promptId);
  const selectedModel = data.models.find((item) => item.id === model);

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
    if (!promptId || !model || !input.trim()) return;
    setResult(undefined);
    run.mutate({ model, promptRevisionId: promptId, toolKeys, input: input.trim() }, { onSuccess: setResult });
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>小香助理 Sandbox</h1>
        <p className="muted">在接上 LINE 前，先用同一套 prompt、模型與工具執行流程測試回答品質。</p>
      </header>

      {!data.configured ? (
        <p className="form-error" role="alert">平台還沒設定 GEMINI_API_KEY，目前只能查看設定，無法執行測試。</p>
      ) : null}

      <div className="assistant-grid">
        <section className="panel">
          <h2 className="panel-title">執行設定</h2>
          <div className="field-grid">
            <label className="field">
              <span>Gemini 模型</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {data.models.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.supported}>
                    {item.label}{item.supported ? "" : "（目前不可用）"}
                  </option>
                ))}
              </select>
              <small>{selectedModel?.note ?? "模型與配額清單沿用 warehouse-inventory 的 snapshot。"}</small>
              <small>目前小香正式使用：{data.models.find((item) => item.id === data.activeModel)?.label ?? data.activeModel}</small>
              <div className="assistant-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!model || model === data.activeModel || saveModel.isPending}
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
            </div>
            <div className="assistant-tool-list">
              {data.tools.map((tool) => (
                <label className="assistant-tool" key={tool.key}>
                  <input
                    type="checkbox"
                    checked={toolKeys.includes(tool.key)}
                    disabled={tool.status === "disabled"}
                    onChange={() => toggleTool(tool.key)}
                  />
                  <span>
                    <strong>{tool.label}</strong>
                    <small>{tool.description}</small>
                  </span>
                  <em className={`status status-${tool.status}`}>{statusLabel(tool.status)}</em>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">System prompt</h2>
            <span className="status status-active">Revision {activeRevision?.revision ?? "—"}</span>
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
            {savePrompt.error ? <span className="form-error">{savePrompt.error.message}</span> : null}
            {savePrompt.isSuccess ? <span className="form-hint">已儲存並套用。</span> : null}
          </div>

          <div className="assistant-subsection">
            <h3>Revision history</h3>
            <div className="assistant-revisions">
              {data.revisions.map((revision) => (
                <button
                  type="button"
                  className={`assistant-revision ${revision.id === promptId ? "selected" : ""}`}
                  key={revision.id}
                  onClick={() => selectRevision(revision)}
                >
                  <span>Revision {revision.revision}{revision.isActive ? " · active" : ""}</span>
                  <small>{formatDate(revision.createdAt)}</small>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <h2 className="panel-title">測試對話</h2>
        <label className="field">
          <span>輸入內容</span>
          <textarea className="assistant-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="輸入要交給小香的問題…" />
        </label>
        <div className="assistant-actions">
          <button type="button" className="primary-button" disabled={!data.configured || run.isPending || !input.trim()} onClick={submitRun}>
            {run.isPending ? "小香思考中…" : "執行測試"}
          </button>
          <span className="form-hint">目前使用 Revision {activeRevision?.revision ?? "—"}、{selectedModel?.label ?? model}。</span>
        </div>
        {run.error ? <p className="form-error" role="alert">{run.error.message}</p> : null}
        {result ? (
          <div className="assistant-result">
            <div className="assistant-result-meta">
              <span>回覆</span>
              <small>{result.durationMs} ms · {result.usage.totalTokens || "—"} tokens · run {result.runId}</small>
            </div>
            <pre>{result.text}</pre>
            {result.toolCalls.length ? (
              <div className="assistant-tool-calls">
                {result.toolCalls.map((call, index) => (
                  <span className={`status ${call.status === "success" ? "status-active" : "status-disabled"}`} key={`${call.toolKey}-${index}`}>
                    {call.toolKey} · {call.status === "success" ? "完成" : call.errorMessage ?? "失敗"} · {call.durationMs} ms
                  </span>
                ))}
              </div>
            ) : <small className="muted">這次沒有呼叫 tool。</small>}
          </div>
        ) : null}
      </section>
    </div>
  );
}
