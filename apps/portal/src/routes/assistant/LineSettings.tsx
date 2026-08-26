import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon } from "../../shell/icons.js";
import { Switch } from "../../shell/Switch.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, TextField } from "../../ui/index.js";
import {
  useAddAssistantLineGroup,
  useAssistantLineConfig,
  useSaveAssistantChannelTools,
  useSaveAssistantGroupTools,
  useSaveAssistantLineConfig,
  useSaveAssistantLineGroup,
  type AssistantGroupToolMode,
  type AssistantLineGroup,
  type AssistantLineSourceType,
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

function sourceTypeLabel(sourceType: AssistantLineSourceType): string {
  if (sourceType === "user") return "一對一";
  if (sourceType === "room") return "多人聊天室";
  return "群組";
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
  const [groupSourceType, setGroupSourceType] = useState<AssistantLineSourceType>("group");
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
  if (config.error) return <div className="page"><Alert tone="danger">{config.error.message}</Alert></div>;
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
    addGroup.mutate({ lineGroupId: groupId.trim(), sourceType: groupSourceType, displayName: groupName.trim() }, {
      onSuccess: () => {
        setGroupId("");
        setGroupName("");
        setGroupSourceType("group");
      },
    });
  }

  return (
    <div className="page">
      <PageHeader
        title="小香 LINE 前台"
        description="群組、多人聊天室與一對一對話都會在這裡管理；只有已啟用的對話會進入線上回覆流程。"
      />

      <Panel
        title="LINE channel 設定"
        description="官方帳號名稱：Rueisiang 小香"
        actions={
          <span className={`status ${data.channel.enabled ? "status-active" : "status-disabled"}`}>
            {data.channel.enabled ? "channel 已開通" : "channel 未開通"}
          </span>
        }
      >

        <form className="line-channel-form" onSubmit={submitChannel}>
          <TextField
            label="LINE Channel ID"
            maxLength={120}
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            placeholder="例如：2001234567"
            hint="Channel ID 會保存到 channel 設定，方便確認目前連接的是哪個 LINE 官方帳號。"
          />
          <TextField
            label="LINE Channel Secret"
            type="password"
            maxLength={500}
            value={channelSecret}
            onChange={(event) => setChannelSecret(event.target.value)}
            placeholder={data.credentials.channelSecretConfigured ? "已設定；輸入新值可覆寫" : "請輸入 Channel Secret"}
            autoComplete="new-password"
            hint="儲存後只保留加密內容，不會再次把 Secret 原值回傳到瀏覽器。"
          />
          <TextField
            label="LINE Channel Access Token"
            type="password"
            maxLength={2_000}
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder={data.credentials.accessTokenConfigured ? "已設定；輸入新值可覆寫" : "請輸入 Channel Access Token"}
            autoComplete="new-password"
            hint="用來透過 Messaging API 回覆 LINE 對話；儲存後只保留加密內容，不會回傳原值。"
          />
          <TextField
            label="後台顯示名稱"
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <label className="assistant-toggle">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>
              <strong>允許 LINE webhook 進入回覆流程</strong>
              <small>關閉時仍會驗證並記錄提及訊息，但不會在線上回覆。</small>
            </span>
          </label>
          <div className="assistant-actions">
            <Button
              type="submit"
              loading={saveChannel.isPending}
              loadingLabel="儲存中…"
              disabled={!channelId.trim() || !displayName.trim()}
            >
              儲存 channel 設定
            </Button>
            {saveChannel.isSuccess ? <span className="form-hint">channel 設定已更新。</span> : null}
            {saveChannel.error ? <Alert tone="danger">{saveChannel.error.message}</Alert> : null}
          </div>
        </form>
      </Panel>

      <Panel
        title="Webhook URL"
        description="請複製這個網址，貼到 LINE Developers 的 Messaging API webhook 設定。"
        actions={
          <span className={`status ${data.credentials.channelSecretConfigured ? "status-active" : "status-disabled"}`}>
            {data.credentials.channelSecretDecryptionFailed
              ? "Channel Secret 無法解密"
              : data.credentials.channelSecretConfigured
                ? "Channel Secret 已設定"
                : "尚未設定 Channel Secret"}
          </span>
        }
      >
        <div className="copy-field">
          <input readOnly value={data.webhookUrl} aria-label="LINE webhook URL" />
          <Button variant="secondary" icon="copy" onClick={() => void copyWebhookUrl()}>
            {copied ? "已複製" : "複製"}
          </Button>
        </div>
        <p className="form-hint">Channel ID 可直接核對；Channel Secret 只顯示設定狀態，原值不會回傳。</p>
        {data.credentials.channelSecretDecryptionFailed || data.credentials.accessTokenDecryptionFailed ? (
          <Alert tone="danger">
            儲存的 LINE 憑證無法解密，可能是 AUTH_SESSION_SECRET 已輪替；請重新輸入並儲存對應憑證。
          </Alert>
        ) : null}
        {data.credentials.accessTokenConfigured ? (
          <p className="form-hint">LINE access token 已設定，已授權對話可以進入 AI 回覆流程。</p>
        ) : (
          <Alert tone="warning">尚未設定 LINE Channel Access Token；目前仍可驗證 webhook 並記錄提及訊息，但不會送出 LINE 回覆。</Alert>
        )}
      </Panel>

      <Panel
        title="小香在 LINE 能用的工具"
        description="這是 LINE 這條路的授權上限。對話只能在這個範圍內再縮小，設定得再寬也不會超過這裡。"
        actions={
          <Button variant="secondary" icon="widgets" onClick={() => setToolsOpen(true)}>
            設定工具
          </Button>
        }
      >

        {lineTools.length === 0 ? (
          <p className="empty-state">目前沒有支援 LINE 的工具。</p>
        ) : grantedTools.length === 0 ? (
          <Alert tone="warning">
            一個工具都沒開，小香在 LINE 只能靠對話本身回答，查不了倉庫或客戶資料。
          </Alert>
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
        {saveChannelTools.error ? <Alert tone="danger">{saveChannelTools.error.message}</Alert> : null}
      </Panel>

      <Panel
        title="已監控 LINE 對話"
        description={
          <>
            Webhook 會自動發現群組與一對一對話；新發現的對話預設關閉，先確認後再讓小香回答。
            <span className="form-hint">一對一不需要 @ 小香。內部測試時可傳送 <code>/reset</code> 或 <code>/重設</code>，清除目前上下文但保留歷史紀錄。</span>
          </>
        }
      >

        <form className="admin-form row" onSubmit={submitGroup}>
          <FilterInput
            label="LINE 對話 ID"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            placeholder="LINE 對話 ID"
          />
          <FilterSelect
            label="LINE 對話類型"
            value={groupSourceType}
            onChange={(event) => setGroupSourceType(event.target.value as AssistantLineSourceType)}
            options={[
              { value: "group", label: "群組" },
              { value: "room", label: "多人聊天室" },
              { value: "user", label: "一對一（user ID）" },
            ]}
          />
          <FilterInput
            label="顯示名稱"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="顯示名稱（選填）"
          />
          <Button type="submit" loading={addGroup.isPending} loadingLabel="新增中…" disabled={!groupId.trim()}>新增對話</Button>
        </form>
        {addGroup.error ? <Alert tone="danger">{addGroup.error.message}</Alert> : null}

        {data.groups.length ? (
          <div className="table-scroll line-groups-table">
            <table className="data-table">
              <thead><tr><th>對話</th><th>LINE ID</th><th>發現時間</th><th>工具</th><th>回覆</th><th>操作</th></tr></thead>
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
        ) : <p className="empty-state">尚未有對話。可以先貼上 LINE webhook 收到的對話 ID，或讓使用者先傳一則訊息給小香。</p>}
        {saveGroup.error ? <Alert tone="danger">{saveGroup.error.message}</Alert> : null}
      </Panel>

      {toolsOpen ? (
        <Dialog
          title="設定小香在 LINE 能用的工具"
          className="wide assistant-modal-card"
          bodyClassName="assistant-modal-body"
          onClose={() => setToolsOpen(false)}
          actions={
            <>
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setChannelToolKeys(data.channelTools.filter((key) => lineTools.some((tool) => tool.key === key)));
                  setToolsOpen(false);
                }}
              >
                取消
              </Button>
              <Button
                loading={saveChannelTools.isPending}
                loadingLabel="儲存中…"
                onClick={() => saveChannelTools.mutate(channelToolKeys, { onSuccess: () => setToolsOpen(false) })}
              >
                儲存
              </Button>
            </>
          }
        >
              <p className="muted">只列出支援 LINE 的工具。這裡沒開的，任何對話都拿不到。</p>
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
        </Dialog>
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
  onSave: (input: { id: string; displayName?: string; enabled: boolean }) => void;
  onOpenTools: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(group.displayName);
  // 大頭貼網址會過期，載入失敗一定會發生。要換成首字圓標，不是留一個空格。
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <tr>
      <td>
        <div className="line-group-cell">
          {group.pictureUrl && !avatarFailed
            ? <img className="line-group-avatar" src={group.pictureUrl} alt="" loading="lazy" onError={() => setAvatarFailed(true)} />
            : <span className="line-group-avatar is-fallback" aria-hidden="true">{(group.displayName || group.lineGroupId).slice(0, 1)}</span>}
          <div className="line-group-main">
            <div className="line-group-label">
              <span className="status status-disabled">{sourceTypeLabel(group.sourceType)}</span>
            </div>
            <FilterInput
              label={`${group.displayName || group.lineGroupId} 對話名稱`}
              className="line-group-name"
              value={name}
              placeholder="未命名對話"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
      </td>
      <td><code>{group.lineGroupId}</code></td>
      <td>{formatDate(group.discoveredAt)}</td>
      <td>
        <button
          type="button"
          className={`line-tool-cell${group.toolMode === "custom" ? " is-custom" : ""}`}
          onClick={onOpenTools}
          title={group.toolMode === "custom"
            ? "只給這個對話指定的工具。點開可修改。"
            : "跟著 channel 的設定走；channel 增減工具時這裡會一起變。點開可改成自訂。"}
        >
          <span className="line-tool-mode">{group.toolMode === "custom" ? "自訂" : "繼承"}</span>
          <span className="line-tool-count">{group.toolMode === "custom" ? group.tools.length : grantedCount} 個工具</span>
        </button>
      </td>
      <td>
        {/*
          * 切了就生效，不用再按儲存——這是 M3 switch 的語意。
          *
          * 只送 enabled，完全不帶 displayName：一來使用者可能正在改名字還沒決定，開關不該
          * 順手把沒確認的值寫進去；二來新發現的對話名稱預設是空的，帶著送會被後端的
          * 「請填寫對話顯示名稱」擋下來，變成要先命名才能開通。
          */}
        <Switch
          checked={group.enabled}
          busy={saving}
          label={`${group.displayName || group.lineGroupId} 的回覆開關`}
          onChange={(next) => onSave({ id: group.id, enabled: next })}
        />
      </td>
      <td>
        <Button
          variant="secondary"
          loading={saving}
          loadingLabel="儲存中…"
          disabled={name.trim() === group.displayName}
          onClick={() => onSave({ id: group.id, displayName: name.trim(), enabled: group.enabled })}
        >
          儲存名稱
        </Button>
      </td>
    </tr>
  );
}

/** 單一對話的工具設定。選項只有 channel 已經授權的那些——後端也會擋，但畫面不該先騙人。 */
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
    <Dialog
      title={`${group.displayName || group.lineGroupId} 的工具`}
      className="wide assistant-modal-card"
      bodyClassName="assistant-modal-body"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>取消</Button>
          <Button
            loading={save.isPending}
            loadingLabel="儲存中…"
            onClick={() => save.mutate(
              { id: group.id, toolMode: mode, toolKeys: keys },
              { onSuccess: onClose },
            )}
          >
            儲存
          </Button>
        </>
      }
    >
          <div className="assistant-tool-mode">
            <label className="assistant-inline-toggle">
              <input type="radio" name="toolMode" checked={mode === "inherit"} onChange={() => setMode("inherit")} />
              <span>
                <strong>繼承</strong>
                <small>用 channel 給的全部（目前 {tools.length} 個）。channel 之後增減，這個對話會跟著變。</small>
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
          {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
    </Dialog>
  );
}
