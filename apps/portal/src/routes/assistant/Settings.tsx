import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { useSaveAssistantToolStatus, useSandboxConfig, type AssistantTool } from "./api.js";

function statusLabel(status: AssistantTool["status"]): string {
  if (status === "enabled") return "已啟用";
  if (status === "development") return "開發中";
  return "已停用";
}

export function AssistantSettings() {
  usePageTitle("小香助理設定");
  const config = useSandboxConfig();
  const saveTool = useSaveAssistantToolStatus();

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><p className="form-error" role="alert">{config.error.message}</p></div>;

  const data = config.data;
  if (!data) return null;
  const activeModel = data.models.find((model) => model.id === data.activeModel);

  return (
    <div className="page">
      <header className="page-head">
        <h1>小香助理設定</h1>
        <p className="muted">設定會直接影響之後的正式小香執行；Sandbox 仍可選其他可用模型做單次測試。</p>
      </header>

      <section className="panel">
        <h2 className="panel-title">目前模型</h2>
        <p className="settings-summary">
          小香目前使用 <strong>{activeModel?.label ?? data.activeModel}</strong>。要更換模型，請到 Sandbox 選擇後按「儲存並套用到小香」。
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Tools</h2>
            <p className="muted">已啟用才可在線上 channel 使用；開發中只能在 Sandbox 測試；已停用不會提供給模型。</p>
          </div>
        </div>

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
              <label className="assistant-status-field">
                <span className="sr-only">{tool.label} 狀態</span>
                <select
                  className="assistant-status-select"
                  value={tool.status}
                  disabled={saveTool.isPending}
                  onChange={(event) => saveTool.mutate({ key: tool.key, status: event.target.value as AssistantTool["status"] })}
                >
                  {(["enabled", "development", "disabled"] as const).map((status) => (
                    <option key={status} value={status}>{statusLabel(status)}</option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>

        {saveTool.error ? <p className="form-error" role="alert">{saveTool.error.message}</p> : null}
        {saveTool.isSuccess ? <p className="form-hint">工具狀態已儲存，Sandbox 與後續 channel 會立即讀取新設定。</p> : null}
      </section>
    </div>
  );
}
