import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Alert, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
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
  if (config.error) return <div className="page"><Alert tone="danger">{config.error.message}</Alert></div>;

  const data = config.data;
  if (!data) return null;
  const activeModel = data.models.find((model) => model.id === data.activeModel);

  return (
    <div className="page">
      <PageHeader title="小香助理設定" description="設定會直接影響之後的正式小香執行；Sandbox 仍可選其他可用模型做單次測試。" />

      <Panel title="目前模型">
        <p className="settings-summary">
          小香目前使用 <strong>{activeModel?.label ?? data.activeModel}</strong>。要更換模型，請到 Sandbox 選擇後按「儲存並套用到小香」。
        </p>
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
