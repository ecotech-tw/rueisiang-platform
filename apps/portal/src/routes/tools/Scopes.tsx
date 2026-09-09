import { useEffect, useMemo, useState } from "react";
import { useArchiveScope, useSaveScope, useScopes, type ManagementScope } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Switch } from "../../shell/Switch.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { useSession } from "../../auth/session.js";

/**
 * 通路管理。
 *
 * 取代原本的「店別與報表設定」與「報表管理 → 管理據點」。那兩頁管的是同一張
 * scopes 表、寫同一個 active 欄位，但篩選條件與刪除行為都不一樣——在其中一邊
 * 關掉一家店，另一邊的執行頁也會跟著消失，而沒有人預期那件事。
 *
 * 這裡叫「通路」不叫「店別」：實體櫃點、蝦皮賣場與之後的其他來源都掛在同一張表，
 * 它們都有自己的銷售明細與金額，差別只在顆粒度與資料怎麼進來。
 */

const KINDS: Array<{ value: ManagementScope["scopeKind"]; label: string; hint: string }> = [
  { value: "store", label: "櫃點", hint: "實體店面或櫃位" },
  { value: "channel", label: "通路", hint: "線上賣場這類沒有實體店面的來源" },
  { value: "company", label: "彙總", hint: "不放資料的容器，不計入公司總額" },
];

const SOURCE_HINTS: Record<string, string> = {
  cyberbiz: "runner 會登入 CYBERBIZ 後台抓這家店的出金與銷售",
  shopee: "蝦皮，報表由人匯出 xlsx 上傳",
  manual: "沒有自動來源，資料靠人工補登",
};

type Draft = {
  key: string;
  id?: string;
  name: string;
  externalName: string;
  sourceType: string;
  scopeKind: ManagementScope["scopeKind"];
  driveFolderUrl: string;
  driveFolderName: string;
  active: boolean;
  archivedAt: string | null;
};

function toDraft(scope: ManagementScope): Draft {
  return { key: scope.id, ...scope };
}

export function Scopes() {
  usePageTitle("通路管理");
  // 來源、種類與 Drive 設定只有管理者能改，API 也擋著；這裡只是不要畫出改不動的欄位。
  const canConfigure = useSession().permissions.has("tools:payout:config");
  const query = useScopes();
  const saveScope = useSaveScope();
  const archiveScope = useArchiveScope();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [archiving, setArchiving] = useState<Draft | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (!query.data || loaded) return;
    setDrafts(query.data.scopes.map(toDraft));
    setLoaded(true);
  }, [query.data, loaded]);

  const visible = useMemo(
    () => drafts.filter((draft) => showArchived || !draft.archivedAt),
    [drafts, showArchived],
  );
  const archivedCount = drafts.filter((draft) => draft.archivedAt).length;
  const busy = saveScope.isPending || archiveScope.isPending;

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  /** 欄位離開就存。新的一列要有名字才存得起來——名稱是唯一必填。 */
  function save(key: string, patch?: Partial<Draft>) {
    const draft = { ...drafts.find((candidate) => candidate.key === key)!, ...patch };
    if (!draft.name.trim()) return;
    saveScope.mutate(draft, {
      onSuccess: (result) => update(key, { id: result.scope.id, archivedAt: result.scope.archivedAt }),
    });
  }

  if (query.isPending) return <div className="boot">載入中…</div>;
  if (query.error) return <div className="page"><Alert tone="danger">{query.error.message}</Alert></div>;

  return (
    <div className="page">
      <PageHeader title="通路管理" />

      <Panel>
        <p className="muted">
          出金表、商品銷售報表與營運統計都掛在通路底下。<strong>停用</strong>只是不再出現在執行頁與補登選單，
          過去的數字照樣算進報表；<strong>封存</strong>則是連管理清單都收起來。兩者都不會刪掉歷史資料。
        </p>

        <div className="admin-form toolbar">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setDrafts((current) => [...current, {
              key: crypto.randomUUID(),
              name: "",
              externalName: "",
              sourceType: "manual",
              scopeKind: "store",
              driveFolderUrl: "",
              driveFolderName: "",
              active: true,
              archivedAt: null,
            }])}
          >
            ＋ 新增通路
          </Button>
          {archivedCount ? (
            <Button variant="link" onClick={() => setShowArchived((current) => !current)}>
              {showArchived ? "隱藏已封存" : `顯示已封存（${archivedCount}）`}
            </Button>
          ) : null}
          {busy ? <span className="form-hint">自動儲存中…</span> : null}
          {!busy && saveScope.isSuccess ? <span className="form-hint">已自動儲存。</span> : null}
        </div>

        {saveScope.error ? <Alert tone="danger">{saveScope.error.message}</Alert> : null}
        {archiveScope.error ? <Alert tone="danger">{archiveScope.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>名稱</th>
                {canConfigure ? <th>種類</th> : null}
                {canConfigure ? <th>來源</th> : null}
                <th>外部店名</th>
                {canConfigure ? <th>Drive 資料夾連結</th> : null}
                {canConfigure ? <th>資料夾顯示名稱</th> : null}
                <th>啟用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((draft, index) => (
                <tr key={draft.key} className={draft.archivedAt ? "muted" : undefined}>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 個通路的名稱`}
                      className="cell-input"
                      value={draft.name}
                      onChange={(event) => update(draft.key, { name: event.target.value })}
                      onBlur={() => save(draft.key)}
                    />
                  </td>
                  {canConfigure ? (
                  <td>
                    <select
                      aria-label={`${draft.name || "這個通路"}的種類`}
                      className="cell-input"
                      value={draft.scopeKind}
                      onChange={(event) => {
                        const scopeKind = event.target.value as ManagementScope["scopeKind"];
                        update(draft.key, { scopeKind });
                        save(draft.key, { scopeKind });
                      }}
                    >
                      {KINDS.map((kind) => (
                        <option key={kind.value} value={kind.value}>{kind.label}</option>
                      ))}
                    </select>
                  </td>
                  ) : null}
                  {canConfigure ? (
                  <td>
                    <Tooltip label={SOURCE_HINTS[draft.sourceType] ?? "自訂來源"}>
                      <input
                        aria-label={`${draft.name || "這個通路"}的來源`}
                        className="cell-input"
                        value={draft.sourceType}
                        onChange={(event) => update(draft.key, { sourceType: event.target.value })}
                        onBlur={() => save(draft.key)}
                      />
                    </Tooltip>
                  </td>
                  ) : null}
                  <td>
                    <input
                      aria-label={`${draft.name || "這個通路"}在外部系統的店名`}
                      className="cell-input"
                      placeholder={draft.sourceType === "cyberbiz" ? "CYBERBIZ 後台的店名" : "不需要"}
                      value={draft.externalName}
                      onChange={(event) => update(draft.key, { externalName: event.target.value })}
                      onBlur={() => save(draft.key)}
                    />
                  </td>
                  {canConfigure ? (
                  <td>
                    <input
                      aria-label={`${draft.name || "這個通路"}的 Drive 連結`}
                      className="cell-input wide"
                      placeholder="https://drive.google.com/drive/folders/…"
                      value={draft.driveFolderUrl}
                      onChange={(event) => update(draft.key, { driveFolderUrl: event.target.value })}
                      onBlur={() => save(draft.key)}
                    />
                  </td>
                  ) : null}
                  {canConfigure ? (
                  <td>
                    <input
                      aria-label={`${draft.name || "這個通路"}的資料夾顯示名稱`}
                      className="cell-input"
                      value={draft.driveFolderName}
                      onChange={(event) => update(draft.key, { driveFolderName: event.target.value })}
                      onBlur={() => save(draft.key)}
                    />
                  </td>
                  ) : null}
                  <td data-label="啟用">
                    <div className="report-store-toggle">
                      <Switch
                        checked={draft.active}
                        busy={busy}
                        onChange={(active) => {
                          update(draft.key, { active });
                          save(draft.key, { active });
                        }}
                        label={`${draft.name || `第 ${index + 1} 個通路`}出現在執行頁與補登選單`}
                      />
                      <span>{draft.archivedAt ? "已封存" : draft.active ? "啟用" : "停用"}</span>
                    </div>
                  </td>
                  <td>
                    {draft.id && !draft.archivedAt ? (
                      <div className="row-actions">
                        <Button
                          variant="icon"
                          icon="box"
                          disabled={busy}
                          onClick={() => setArchiving(draft)}
                          title={`封存 ${draft.name || "這個通路"}`}
                          aria-label={`封存 ${draft.name || `第 ${index + 1} 個通路`}`}
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {visible.length === 0 ? <p className="muted table-note">目前沒有通路，報表執行頁會是空的。</p> : null}
      </Panel>

      {archiving ? (
        <ConfirmDialog
          title={`封存「${archiving.name || "這個通路"}」？`}
          confirmLabel="封存"
          pending={archiveScope.isPending}
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            const target = archiving;
            setArchiving(null);
            if (!target.id) return;
            archiveScope.mutate(target.id, {
              onSuccess: () => update(target.key, { active: false, archivedAt: new Date().toISOString() }),
            });
          }}
        >
          <p><strong>{archiving.name || "這個通路"}</strong> 會從執行頁、補登選單與這張清單收起來。</p>
          <p className="muted">已匯入的出金與商品銷售不會被刪除，營運統計仍然算得到它。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
