import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Switch } from "../../shell/Switch.js";
import {
  useAddAssistantLineGroup,
  useAssistantLineConfig,
  useSaveAssistantChannelTools,
  useSaveAssistantGroupTools,
  useSaveAssistantLineConfig,
  useSaveAssistantLineGroup,
  type AssistantGroupToolMode,
  type AssistantLineGroup,
  type AssistantTool,
} from "./api.js";

/**
 * 工具在 LINE 上實際能不能用，是三層的交集：全域狀態 ∩ channel 白名單 ∩ 對話白名單。
 * 後台一定要說得出「卡在哪一層」——不講的話，使用者會勾好一個工具、發現沒作用，
 * 然後花很久才找到是別層擋的。
 */
function blockedReason(tool: AssistantTool): string | null {
  if (tool.status === "disabled") return "已停用";
  if (tool.status === "development") return "開發中，只能在 Sandbox 用";
  return null;
}

function formatDate(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW", { hour12: false });
}

export function LineSettings() {
  usePageTitle("小香 LINE 前台");
  const config = useAssistantLineConfig();
  const saveChannel = useSaveAssistantLineConfig();
  const addGroup = useAddAssistantLineGroup();
  const saveGroup = useSaveAssistantLineGroup();
  const saveChannelTools = useSaveAssistantChannelTools();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [channelToolKeys, setChannelToolKeys] = useState<string[]>([]);
  const [groupToolsFor, setGroupToolsFor] = useState<AssistantLineGroup | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelSecret, setChannelSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!config.data) return;
    setDisplayName(config.data.channel.displayName);
    setChannelId(config.data.channel.channelId);
    setEnabled(config.data.channel.enabled);
    // 後端已經濾過一次，這裡再濾一次是因為「送出去的內容」必須自己保證合法，
    // 不能假設上游一定乾淨——原封不動按儲存卻被退回是最難查的那種錯。
    const known = new Set(config.data.tools.map((tool) => tool.key));
    setChannelToolKeys(config.data.channelTools.filter((key) => known.has(key)));
  }, [config.data]);

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><p className="form-error" role="alert">{config.error.message}</p></div>;
  const data = config.data;
  if (!data) return null;

  /*
   * 目錄直接取自 /line/config。不要改用 /sandbox/config——那支要 assistant:sandbox:read，
   * 只有 LINE 權限的人拿不到，畫面會變成「一個工具都沒有」，看起來像設定錯誤，
   * 其實是權限擋住的假象。
   */
  const lineTools = data.tools;
  const grantedTools = lineTools.filter((tool) => data.channelTools.includes(tool.key));

  async function copyWebhookUrl() {
    await navigator.clipboard.writeText(data.webhookUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function submitChannel(event: React.FormEvent) {
    event.preventDefault();
    saveChannel.mutate({ channelId: channelId.trim(), channelSecret, accessToken, displayName: displayName.trim(), enabled }, {
      onSuccess: () => {
        setChannelSecret("");
        setAccessToken("");
      },
    });
  }

  function submitGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!groupId.trim()) return;
    addGroup.mutate({ lineGroupId: groupId.trim(), displayName: groupName.trim() }, {
      onSuccess: () => {
        setGroupId("");
        setGroupName("");
      },
    });
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>小香 LINE 前台</h1>
        <p className="muted">把 Rueisiang 小香加入群組後，先在這裡授權群組；只有已啟用的群組會進入後續線上回覆流程。</p>
      </header>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">LINE channel 設定</h2>
            <p className="muted">官方帳號名稱：Rueisiang 小香</p>
          </div>
          <span className={`status ${data.channel.enabled ? "status-active" : "status-disabled"}`}>
            {data.channel.enabled ? "channel 已開通" : "channel 未開通"}
          </span>
        </div>

        <form className="line-channel-form" onSubmit={submitChannel}>
          <label className="field">
            <span>LINE Channel ID</span>
            <input value={channelId} maxLength={120} onChange={(event) => setChannelId(event.target.value)} placeholder="例如：2001234567" />
            <small>Channel ID 會保存到 channel 設定，方便確認目前連接的是哪個 LINE 官方帳號。</small>
          </label>
          <label className="field">
            <span>LINE Channel Secret</span>
            <input type="password" value={channelSecret} maxLength={500} onChange={(event) => setChannelSecret(event.target.value)} placeholder={data.credentials.channelSecretConfigured ? "已設定；輸入新值可覆寫" : "請輸入 Channel Secret"} autoComplete="new-password" />
            <small>儲存後只保留加密內容，不會再次把 Secret 原值回傳到瀏覽器。</small>
          </label>
          <label className="field">
            <span>LINE Channel Access Token</span>
            <input type="password" value={accessToken} maxLength={2_000} onChange={(event) => setAccessToken(event.target.value)} placeholder={data.credentials.accessTokenConfigured ? "已設定；輸入新值可覆寫" : "請輸入 Channel Access Token"} autoComplete="new-password" />
            <small>用來透過 Messaging API 回覆群組；儲存後只保留加密內容，不會回傳原值。</small>
          </label>
          <label className="field">
            <span>後台顯示名稱</span>
            <input value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="assistant-toggle">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>
              <strong>允許 LINE webhook 進入回覆流程</strong>
              <small>關閉時仍會驗證並記錄提及訊息，但不會在線上回覆。</small>
            </span>
          </label>
          <div className="assistant-actions">
            <button type="submit" className="primary-button" disabled={!channelId.trim() || !displayName.trim() || saveChannel.isPending}>
              {saveChannel.isPending ? "儲存中…" : "儲存 channel 設定"}
            </button>
            {saveChannel.isSuccess ? <span className="form-hint">channel 設定已更新。</span> : null}
            {saveChannel.error ? <span className="form-error">{saveChannel.error.message}</span> : null}
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Webhook URL</h2>
            <p className="muted">請複製這個網址，貼到 LINE Developers 的 Messaging API webhook 設定。</p>
          </div>
          <span className={`status ${data.credentials.channelSecretConfigured ? "status-active" : "status-disabled"}`}>
            {data.credentials.channelSecretDecryptionFailed
              ? "Channel Secret 無法解密"
              : data.credentials.channelSecretConfigured
                ? "Channel Secret 已設定"
                : "尚未設定 Channel Secret"}
          </span>
        </div>
        <div className="copy-field">
          <input readOnly value={data.webhookUrl} aria-label="LINE webhook URL" />
          <button type="button" className="ghost-button" onClick={() => void copyWebhookUrl()}>
            <Icon name="copy" />
            {copied ? "已複製" : "複製"}
          </button>
        </div>
        <p className="form-hint">Channel ID 可直接核對；Channel Secret 只顯示設定狀態，原值不會回傳。</p>
        {data.credentials.channelSecretDecryptionFailed || data.credentials.accessTokenDecryptionFailed ? (
          <p className="form-error" role="alert">
            儲存的 LINE 憑證無法解密，可能是 AUTH_SESSION_SECRET 已輪替；請重新輸入並儲存對應憑證。
          </p>
        ) : null}
        <p className={`form-hint ${data.credentials.accessTokenConfigured ? "" : "form-error"}`}>
          {data.credentials.accessTokenConfigured
            ? "LINE access token 已設定，已授權群組可以進入 AI 回覆流程。"
            : "尚未設定 LINE Channel Access Token；目前仍可驗證 webhook 並記錄提及訊息，但不會送出 LINE 回覆。"}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">小香在 LINE 能用的工具</h2>
            <p className="muted">
              這是 LINE 這條路的授權上限。群組只能在這個範圍內再縮小，設定得再寬也不會超過這裡。
            </p>
          </div>
          <button type="button" className="ghost-button with-icon" onClick={() => setToolsOpen(true)}>
            <Icon name="widgets" />
            設定工具
          </button>
        </div>

        {lineTools.length === 0 ? (
          <p className="empty-state">目前沒有支援 LINE 的工具。</p>
        ) : grantedTools.length === 0 ? (
          <p className="form-error" role="alert">
            一個工具都沒開，小香在 LINE 只能靠對話本身回答，查不了倉庫或客戶資料。
          </p>
        ) : (
          <ul className="assistant-granted-tools">
            {grantedTools.map((tool) => {
              const blocked = blockedReason(tool);
              return (
                <li key={tool.key}>
                  <strong>{tool.label}</strong>
                  {blocked ? <em className="status status-development">{blocked}</em> : null}
                </li>
              );
            })}
          </ul>
        )}
        {saveChannelTools.error ? <p className="form-error" role="alert">{saveChannelTools.error.message}</p> : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">已授權 LINE 群組</h2>
            <p className="muted">Webhook 收到標註後會自動發現群組；新發現的群組預設關閉，避免未確認的群組直接收到回答。</p>
          </div>
        </div>

        <form className="admin-form row" onSubmit={submitGroup}>
          <input value={groupId} onChange={(event) => setGroupId(event.target.value)} placeholder="LINE group ID" aria-label="LINE group ID" />
          <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="群組名稱（選填）" aria-label="群組名稱" />
          <button type="submit" className="primary-button" disabled={!groupId.trim() || addGroup.isPending}>新增群組</button>
        </form>
        {addGroup.error ? <p className="form-error" role="alert">{addGroup.error.message}</p> : null}

        {data.groups.length ? (
          <div className="table-scroll line-groups-table">
            <table className="data-table">
              <thead><tr><th>群組</th><th>LINE ID</th><th>發現時間</th><th>工具</th><th>回覆</th><th>操作</th></tr></thead>
              <tbody>
                {data.groups.map((group) => (
                  <LineGroupRow
                    key={group.id}
                    group={group}
                    grantedCount={data.channelTools.length}
                    onSave={saveGroup.mutate}
                    onOpenTools={() => setGroupToolsFor(group)}
                    saving={saveGroup.isPending && saveGroup.variables?.id === group.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty-state">尚未有群組。可以先貼上 LINE webhook 收到的 group ID，或把小香加入群組後標註一次。</p>}
        {saveGroup.error ? <p className="form-error" role="alert">{saveGroup.error.message}</p> : null}
      </section>

      {toolsOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setToolsOpen(false);
          }}
        >
          <div className="modal-card wide assistant-modal-card" role="dialog" aria-modal="true" aria-labelledby="line-channel-tools-title">
            <div className="modal-head">
              <h2 id="line-channel-tools-title">設定小香在 LINE 能用的工具</h2>
              <button type="button" className="icon-button" onClick={() => setToolsOpen(false)} title="關閉" aria-label="關閉">
                <Icon name="close" />
              </button>
            </div>
            <div className="modal-body assistant-modal-body">
              <p className="muted">只列出支援 LINE 的工具。這裡沒開的，任何群組都拿不到。</p>
              <div className="assistant-tool-list">
                {lineTools.map((tool) => {
                  const blocked = blockedReason(tool);
                  return (
                    <label className="assistant-tool" key={tool.key}>
                      <span className="assistant-tool-control">
                        <input
                          type="checkbox"
                          checked={channelToolKeys.includes(tool.key)}
                          onChange={() => setChannelToolKeys((keys) => keys.includes(tool.key)
                            ? keys.filter((key) => key !== tool.key)
                            : [...keys, tool.key])}
                        />
                        <Icon name="widgets" />
                      </span>
                      <span>
                        <strong>{tool.label}</strong>
                        <small>{tool.description}</small>
                      </span>
                      {blocked ? <em className="status status-development">{blocked}</em> : null}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => { setChannelToolKeys(data.channelTools.filter((key) => lineTools.some((tool) => tool.key === key))); setToolsOpen(false); }}>取消</button>
              <button
                type="button"
                className="primary-button"
                disabled={saveChannelTools.isPending}
                onClick={() => saveChannelTools.mutate(channelToolKeys, { onSuccess: () => setToolsOpen(false) })}
              >
                {saveChannelTools.isPending ? "儲存中…" : "儲存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {groupToolsFor ? (
        <GroupToolsDialog
          group={groupToolsFor}
          tools={lineTools.filter((tool) => data.channelTools.includes(tool.key))}
          onClose={() => setGroupToolsFor(null)}
        />
      ) : null}
    </div>
  );
}

function LineGroupRow({
  group,
  grantedCount,
  onSave,
  onOpenTools,
  saving,
}: {
  group: AssistantLineGroup;
  grantedCount: number;
  onSave: (input: { id: string; displayName: string; enabled: boolean }) => void;
  onOpenTools: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(group.displayName);
  return (
    <tr>
      <td><input className="line-group-name" value={name} placeholder="未命名群組" onChange={(event) => setName(event.target.value)} /></td>
      <td><code>{group.lineGroupId}</code></td>
      <td>{formatDate(group.discoveredAt)}</td>
      <td>
        <button
          type="button"
          className={`line-tool-cell${group.toolMode === "custom" ? " is-custom" : ""}`}
          onClick={onOpenTools}
          title={group.toolMode === "custom"
            ? "只給這個群組指定的工具。點開可修改。"
            : "跟著 channel 的設定走；channel 增減工具時這裡會一起變。點開可改成自訂。"}
        >
          <span className="line-tool-mode">{group.toolMode === "custom" ? "自訂" : "繼承"}</span>
          <span className="line-tool-count">{group.toolMode === "custom" ? group.tools.length : grantedCount} 個工具</span>
        </button>
      </td>
      <td>
        {/*
          * 切了就生效，不用再按儲存——這是 M3 switch 的語意。
          * 送出的是已存檔的 displayName 而不是編輯中的 name：使用者可能正在改名字還沒決定，
          * 開關不該順手把那個沒確認的值一起寫進去。
          */}
        <Switch
          checked={group.enabled}
          busy={saving}
          label={`${group.displayName || group.lineGroupId} 的回覆開關`}
          onChange={(next) => onSave({ id: group.id, displayName: group.displayName, enabled: next })}
        />
      </td>
      <td>
        <button
          type="button"
          className="ghost-button"
          disabled={saving || name.trim() === group.displayName}
          onClick={() => onSave({ id: group.id, displayName: name.trim(), enabled: group.enabled })}
        >
          儲存名稱
        </button>
      </td>
    </tr>
  );
}

/** 單一群組的工具設定。選項只有 channel 已經授權的那些——後端也會擋，但畫面不該先騙人。 */
function GroupToolsDialog({
  group,
  tools,
  onClose,
}: {
  group: AssistantLineGroup;
  tools: AssistantTool[];
  onClose: () => void;
}) {
  const save = useSaveAssistantGroupTools();
  const [mode, setMode] = useState<AssistantGroupToolMode>(group.toolMode);
  const [keys, setKeys] = useState<string[]>(group.tools);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card wide assistant-modal-card" role="dialog" aria-modal="true" aria-labelledby="line-group-tools-title">
        <div className="modal-head">
          <h2 id="line-group-tools-title">{group.displayName || group.lineGroupId} 的工具</h2>
          <button type="button" className="icon-button" onClick={onClose} title="關閉" aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body assistant-modal-body">
          <div className="assistant-tool-mode">
            <label className="assistant-inline-toggle">
              <input type="radio" name="toolMode" checked={mode === "inherit"} onChange={() => setMode("inherit")} />
              <span>
                <strong>繼承</strong>
                <small>用 channel 給的全部（目前 {tools.length} 個）。channel 之後增減，這個群組會跟著變。</small>
              </span>
            </label>
            <label className="assistant-inline-toggle">
              <input type="radio" name="toolMode" checked={mode === "custom"} onChange={() => setMode("custom")} />
              <span>
                <strong>自訂</strong>
                <small>只給下面勾選的。channel 收回某個工具時，這裡也會跟著消失。</small>
              </span>
            </label>
          </div>

          {mode === "custom" ? (
            tools.length ? (
              <div className="assistant-tool-list">
                {tools.map((tool) => (
                  <label className="assistant-tool" key={tool.key}>
                    <span className="assistant-tool-control">
                      <input
                        type="checkbox"
                        checked={keys.includes(tool.key)}
                        onChange={() => setKeys((current) => current.includes(tool.key)
                          ? current.filter((key) => key !== tool.key)
                          : [...current, tool.key])}
                      />
                      <Icon name="widgets" />
                    </span>
                    <span>
                      <strong>{tool.label}</strong>
                      <small>{tool.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : <p className="empty-state">channel 還沒授權任何工具，這裡沒有東西可以挑。</p>
          ) : null}
          {save.error ? <p className="form-error" role="alert">{save.error.message}</p> : null}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            disabled={save.isPending}
            onClick={() => save.mutate(
              { id: group.id, toolMode: mode, toolKeys: keys },
              { onSuccess: onClose },
            )}
          >
            {save.isPending ? "儲存中…" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}
