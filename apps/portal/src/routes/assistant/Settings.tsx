import { useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
import { useSaveAssistantToolStatus, useSavePiCodexCredential, useSandboxConfig, type AssistantTool } from "./api.js";

function statusLabel(status: AssistantTool["status"]): string {
  if (status === "enabled") return "已啟用";
  if (status === "development") return "開發中";
  return "已停用";
}

export function AssistantSettings() {
  usePageTitle("小香助理設定");
  const config = useSandboxConfig();
  const saveTool = useSaveAssistantToolStatus();
  const saveCodexCredential = useSavePiCodexCredential();
  const [credential, setCredential] = useState("");

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><Alert tone="danger">{config.error.message}</Alert></div>;

  const data = config.data;
  if (!data) return null;
  const activeModel = data.models.find((model) => model.id === data.activeModel);
  const fallbackModel = data.fallbackModel ? data.models.find((model) => model.id === data.fallbackModel) : undefined;

  function submitCredential() {
    const value = credential.trim();
    if (!value) return;
    saveCodexCredential.mutate(value, { onSuccess: () => setCredential("") });
  }

  return (
    <div className="page">
      <PageHeader title="小香助理設定" description="設定會直接影響之後的正式小香執行；Sandbox 仍可選其他可用模型做單次測試。" />

      <Panel title="目前模型">
        <p className="settings-summary">
          小香目前使用 <strong>{activeModel?.label ?? data.activeModel}</strong>。
          {fallbackModel ? <> 失敗時會 fallback 到 <strong>{fallbackModel.label}</strong>。</> : " 目前沒有設定 fallback。"}
          要更換模型或 fallback，請到 Sandbox 設定。
        </p>
        {data.credentialStatus.codex === "needs_reauth" ? (
          <Alert tone="danger">ChatGPT／Codex OAuth 最近回傳 401，請重新執行 codex login 並更新平台 credential。</Alert>
        ) : null}
      </Panel>

      <Panel title="ChatGPT／Codex OAuth credential" description="credential 會由唯一的 vault Durable Object 加密保存並自動輪替；不需要把 refresh token 放在 Worker secret。">
        <p className="settings-summary">
          目前狀態：<strong>{data.credentialStatus.codex === "needs_reauth" ? "需要重新授權" : data.credentialStatus.codex === "ready" ? "可使用" : "尚未設定"}</strong>。
          可貼上 Pi `auth.json` 全文，或只貼 `openai-codex` credential JSON；儲存成功後輸入內容會立即清除。
        </p>
        <label className="field">
          <span>Pi／Codex credential JSON</span>
          <textarea
            className="assistant-textarea"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={'{"openai-codex":{"access":"...","refresh":"...","expires":...}}'}
          />
          <small>只會送到目前平台的 HTTPS API；API 回應不包含 access 或 refresh token。</small>
        </label>
        <div className="assistant-actions">
          <Button
            loading={saveCodexCredential.isPending}
            loadingLabel="匯入中…"
            disabled={!credential.trim()}
            onClick={submitCredential}
          >
            匯入並更新 credential
          </Button>
          {saveCodexCredential.isSuccess ? <span className="form-hint">Codex credential 已更新，之後由 vault 自動 refresh。</span> : null}
          {saveCodexCredential.error ? <Alert tone="danger">{saveCodexCredential.error.message}</Alert> : null}
        </div>
      </Panel>

      <Panel title="Tools" description="已啟用才可在線上 channel 使用；開發中只能在 Sandbox 測試；已停用不會提供給模型。">

        <div className="assistant-tool-list">
          {data.tools.map((tool) => (
            <div className="assistant-tool" key={tool.key}>
              <Icon name="widgets" />
                <span>
                  <strong>{tool.label}</strong>
                  <small>{tool.description}</small>
                  <small>{tool.key}</small>
                  <small>可用於：{tool.surfaces.join("、")}{tool.requiredPermissions.length ? ` · 需要：${tool.requiredPermissions.join("、")}` : ""}</small>
                </span>
              <FilterSelect
                label={`${tool.label} 狀態`}
                className="assistant-status-select"
                value={tool.status}
                disabled={saveTool.isPending}
                onChange={(event) => saveTool.mutate({ key: tool.key, status: event.target.value as AssistantTool["status"] })}
                options={(["enabled", "development", "disabled"] as const).map((status) => ({
                  value: status,
                  label: statusLabel(status),
                }))}
              />
            </div>
          ))}
        </div>

        {saveTool.error ? <Alert tone="danger">{saveTool.error.message}</Alert> : null}
        {saveTool.isSuccess ? <p className="form-hint">工具狀態已儲存，Sandbox 與後續 channel 會立即讀取新設定。</p> : null}
      </Panel>
    </div>
  );
}
