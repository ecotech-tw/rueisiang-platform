import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import {
  useAddAssistantLineGroup,
  useAssistantLineConfig,
  useSaveAssistantLineConfig,
  useSaveAssistantLineGroup,
} from "./api.js";

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
  }, [config.data]);

  if (config.isPending) return <div className="boot">載入中…</div>;
  if (config.error) return <div className="page"><p className="form-error" role="alert">{config.error.message}</p></div>;
  const data = config.data;
  if (!data) return null;

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
            {data.credentials.channelSecretConfigured ? "Channel Secret 已設定" : "尚未設定 Channel Secret"}
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
        <p className={`form-hint ${data.credentials.accessTokenConfigured ? "" : "form-error"}`}>
          {data.credentials.accessTokenConfigured
            ? "LINE access token 已設定，已授權群組可以進入 AI 回覆流程。"
            : "尚未設定 LINE Channel Access Token；目前仍可驗證 webhook 並記錄提及訊息，但不會送出 LINE 回覆。"}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">已授權 LINE 群組</h2>
            <p className="muted">Webhook 收到標註後會自動發現群組；新發現的群組預設關閉，避免未確認的群組直接收到回答。</p>
          </div>
        </div>

        <form className="admin-form inline" onSubmit={submitGroup}>
          <input value={groupId} onChange={(event) => setGroupId(event.target.value)} placeholder="LINE group ID" aria-label="LINE group ID" />
          <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="群組名稱（選填）" aria-label="群組名稱" />
          <button type="submit" className="primary-button" disabled={!groupId.trim() || addGroup.isPending}>新增群組</button>
        </form>
        {addGroup.error ? <p className="form-error" role="alert">{addGroup.error.message}</p> : null}

        {data.groups.length ? (
          <div className="table-scroll line-groups-table">
            <table className="data-table">
              <thead><tr><th>群組</th><th>LINE ID</th><th>發現時間</th><th>回覆</th><th>操作</th></tr></thead>
              <tbody>
                {data.groups.map((group) => (
                  <LineGroupRow key={group.id} group={group} onSave={saveGroup.mutate} saving={saveGroup.isPending} />
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty-state">尚未有群組。可以先貼上 LINE webhook 收到的 group ID，或把小香加入群組後標註一次。</p>}
        {saveGroup.error ? <p className="form-error" role="alert">{saveGroup.error.message}</p> : null}
      </section>
    </div>
  );
}

function LineGroupRow({
  group,
  onSave,
  saving,
}: {
  group: NonNullable<ReturnType<typeof useAssistantLineConfig>["data"]>["groups"][number];
  onSave: (input: { id: string; displayName: string; enabled: boolean }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(group.displayName);
  const [enabled, setEnabled] = useState(group.enabled);
  return (
    <tr>
      <td><input className="line-group-name" value={name} placeholder="未命名群組" onChange={(event) => setName(event.target.value)} /></td>
      <td><code>{group.lineGroupId}</code></td>
      <td>{formatDate(group.discoveredAt)}</td>
      <td>
        <label className="assistant-inline-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>{enabled ? "已開通" : "未開通"}</span>
        </label>
      </td>
      <td><button type="button" className="ghost-button" disabled={saving} onClick={() => onSave({ id: group.id, displayName: name.trim(), enabled })}>儲存</button></td>
    </tr>
  );
}
