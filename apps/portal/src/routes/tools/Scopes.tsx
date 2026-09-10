import { useMemo, useState } from "react";
import { useArchiveScope, useSaveScope, useScopes, type ManagementScope } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useSession } from "../../auth/session.js";
import { Switch } from "../../shell/Switch.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";

/**
 * 通路管理。
 *
 * 取代原本的「店別與報表設定」與「報表管理 → 管理據點」。那兩頁管的是同一張
 * scopes 表、寫同一個 active 欄位，但篩選條件與刪除行為都不一樣——在其中一邊
 * 關掉一家店，另一邊的執行頁也會跟著消失，而沒有人預期那件事。
 *
 * 叫「通路」不叫「店別」：實體櫃點、蝦皮賣場與之後的其他來源都掛在同一張表，
 * 它們都有自己的銷售明細與金額，差別只在顆粒度與資料怎麼進來。
 */

const KIND_OPTIONS = [
  { value: "store", label: "櫃點" },
  { value: "channel", label: "通路" },
  { value: "company", label: "彙總" },
] as const;

const KIND_LABELS: Record<ManagementScope["scopeKind"], string> = {
  store: "櫃點",
  channel: "通路",
  company: "彙總",
};

/**
 * 來源＝這個通路的資料由哪一支 driver 進來，所以是固定的清單而不是自由文字。
 *
 * 只有 cyberbiz 會被出金表與商品銷售報表的 runner 執行；shopee 是人匯出 xlsx
 * 再上傳；manual 完全靠人工補登。之後接新的 driver 就在這裡加一個。
 */
const SOURCE_OPTIONS = [
  { value: "cyberbiz", label: "CYBERBIZ" },
  { value: "shopee", label: "蝦皮" },
  { value: "manual", label: "其他" },
] as const;

const SOURCE_LABELS: Record<string, string> = {
  cyberbiz: "CYBERBIZ",
  shopee: "蝦皮",
  manual: "其他",
};

function sourceLabel(sourceType: string): string {
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

function ScopeDialog({
  scope,
  canConfigure,
  onClose,
}: {
  scope: ManagementScope | null;
  canConfigure: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(scope?.name ?? "");
  const [externalName, setExternalName] = useState(scope?.externalName ?? "");
  const [sourceType, setSourceType] = useState(scope?.sourceType ?? "manual");
  const [scopeKind, setScopeKind] = useState<ManagementScope["scopeKind"]>(scope?.scopeKind ?? "store");
  const [driveFolderUrl, setDriveFolderUrl] = useState(scope?.driveFolderUrl ?? "");
  const [driveFolderName, setDriveFolderName] = useState(scope?.driveFolderName ?? "");
  const save = useSaveScope();
  const toast = useToast();
  const valid = name.trim() !== "";
  // 舊資料可能有清單以外的來源；不能因為選單沒有就把它悄悄換掉。
  const sourceOptions = SOURCE_OPTIONS.some((option) => option.value === sourceType)
    ? SOURCE_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    : [{ label: sourceType, value: sourceType }, ...SOURCE_OPTIONS.map((option) => ({ label: option.label, value: option.value }))];

  return (
    <Dialog
      title={scope ? "編輯通路" : "新增通路"}
      onClose={onClose}
      closeDisabled={save.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          save.mutate({
            ...(scope ? { id: scope.id } : {}),
            name: name.trim(),
            // 外部店名只有 CYBERBIZ 用得到；換了來源就把它清掉，不要留一個
            // 沒有人會再讀、卻看起來還有效的值。
            // 沒有 config 權限的人送這幾個欄位會被 API 擋成 403，所以乾脆不送。
            ...(canConfigure ? {
              sourceType,
              scopeKind,
              driveFolderUrl,
              driveFolderName,
              // 外部店名只有 CYBERBIZ 用得到；換了來源就清掉，不要留一個沒有人
              // 會再讀、卻看起來還有效的值。
              externalName: sourceType === "cyberbiz" ? externalName.trim() : "",
            } : {}),
          }, {
            onSuccess: () => {
              toast.show(scope ? `已更新「${name.trim()}」` : `已新增通路「${name.trim()}」`);
              onClose();
            },
          });
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={save.isPending}>取消</Button>
          <Button type="submit" loading={save.isPending} disabled={!valid}>儲存</Button>
        </>
      }
    >
      <TextField
        label="通路名稱"
        required
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint="平台上顯示的名字，隨時可以改。報表資料綁的是 ID，改名不會拆散歷史。"
      />
      {canConfigure ? (
        <SelectField
          label="種類"
          value={scopeKind}
          onChange={(event) => setScopeKind(event.target.value as ManagementScope["scopeKind"])}
          options={KIND_OPTIONS.map((kind) => ({ label: kind.label, value: kind.value }))}
        />
      ) : null}
      {canConfigure ? (
        <SelectField
          label="來源"
          value={sourceType}
          onChange={(event) => setSourceType(event.target.value)}
          options={sourceOptions}
        />
      ) : null}
      {canConfigure && sourceType === "cyberbiz" ? (
        <TextField
          label="外部店名"
          value={externalName}
          onChange={(event) => setExternalName(event.target.value)}
          hint="CYBERBIZ 後台的店名，runner 拿它找店。跟平台名稱不一樣時才要填。"
        />
      ) : null}
      {canConfigure ? (
        <TextField
          label="Google Drive 資料夾連結"
          value={driveFolderUrl}
          onChange={(event) => setDriveFolderUrl(event.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          hint="報表整理完會放到這個資料夾。"
        />
      ) : null}
      {canConfigure ? (
        <TextField
          label="資料夾顯示名稱"
          value={driveFolderName}
          onChange={(event) => setDriveFolderName(event.target.value)}
        />
      ) : null}
    </Dialog>
  );
}

export function Scopes() {
  usePageTitle("通路管理");
  // 來源、種類與 Drive 設定只有管理者能改，API 也擋著；這裡只是不要畫出改不動的欄位。
  const canConfigure = useSession().permissions.has("tools:payout:config");
  const query = useScopes();
  const archiveScope = useArchiveScope();
  const saveScope = useSaveScope();
  const toast = useToast();

  const [editing, setEditing] = useState<{ scope: ManagementScope | null } | null>(null);
  const [archiving, setArchiving] = useState<ManagementScope | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [kindFilter, setKindFilter] = useState("all");
  const [sortField, setSortField] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const scopes = useMemo(() => query.data?.scopes ?? [], [query.data]);

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = scopes.filter((scope) => {
      if (statusFilter === "open" && (scope.archivedAt || !scope.active)) return false;
      if (statusFilter === "closed" && (scope.archivedAt || scope.active)) return false;
      if (statusFilter === "archived" && !scope.archivedAt) return false;
      if (kindFilter !== "all" && scope.scopeKind !== kindFilter) return false;
      if (!keyword) return true;
      return [scope.name, scope.externalName, sourceLabel(scope.sourceType), scope.sourceType]
        .some((value) => value.toLowerCase().includes(keyword));
    });
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => {
      if (sortField === "kind") return direction * KIND_LABELS[left.scopeKind].localeCompare(KIND_LABELS[right.scopeKind], "zh-Hant");
      if (sortField === "source") return direction * sourceLabel(left.sourceType).localeCompare(sourceLabel(right.sourceType), "zh-Hant");
      return direction * left.name.localeCompare(right.name, "zh-Hant");
    });
  }, [scopes, search, statusFilter, kindFilter, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function sort(field: string, direction: "asc" | "desc") {
    setSortField(field);
    setSortDirection(direction);
    setPage(1);
  }

  /**
   * 這個開關寫的是「這個通路還在營業」。
   *
   * 成功才跳 toast；失敗留在面板上緣的 Alert，那是 Toast.tsx 檔頭的決定——失敗
   * 是要人讀完處理的東西，不能做成會自己消失的浮動提示。
   *
   * 關掉之後它不再出現在出金表／商品銷售報表的執行頁，也不能再補登資料；已經
   * 匯入的數字照樣算進營運統計——報表是歷史，不會因為關掉開關就變少。
   */
  function toggleActive(scope: ManagementScope, active: boolean) {
    saveScope.mutate({ id: scope.id, name: scope.name, active }, {
      onSuccess: () => toast.show(active
        ? `「${scope.name}」恢復營業，會重新出現在報表執行頁`
        : `「${scope.name}」已停業，歷史數字仍算進營運統計`),
    });
  }

  /** 還原＝解除封存並恢復營業；API 的 active: true 會一併把 archived_at 清掉。 */
  function restore(scope: ManagementScope) {
    saveScope.mutate({ id: scope.id, name: scope.name, active: true }, {
      onSuccess: () => toast.show(`已還原「${scope.name}」`),
    });
  }

  if (query.isPending) return <div className="boot">載入中…</div>;
  if (query.error) return <div className="page"><Alert tone="danger">{query.error.message}</Alert></div>;

  return (
    <div className="page fills">
      <PageHeader
        title="通路管理"
        description="出金表、商品銷售報表與營運統計都掛在通路底下。停業與封存都不會刪掉已經匯入的歷史資料。"
        actions={<Button icon="plus" onClick={() => setEditing({ scope: null })}>新增通路</Button>}
      />

      <Panel className="grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput
            label="搜尋"
            className="search-input"
            type="search"
            placeholder="搜尋通路名稱、外部店名或來源"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
          <FilterSelect
            label="狀態"
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
            options={[
              { value: "open", label: "營業中" },
              { value: "closed", label: "已停業" },
              { value: "archived", label: "已封存" },
              { value: "all", label: "全部" },
            ]}
          />
          <FilterSelect
            label="種類"
            value={kindFilter}
            onChange={(event) => { setKindFilter(event.target.value); setPage(1); }}
            options={[{ value: "all", label: "全部種類" }, ...KIND_OPTIONS.map((kind) => ({ value: kind.value, label: kind.label }))]}
          />
        </form>

        {saveScope.error ? <Alert tone="danger">{saveScope.error.message}</Alert> : null}
        {archiveScope.error ? <Alert tone="danger">{archiveScope.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="通路" field="name" active={sortField} direction={sortDirection} onSort={sort} />
                <SortableHeader label="種類" field="kind" active={sortField} direction={sortDirection} onSort={sort} />
                <SortableHeader label="來源" field="source" active={sortField} direction={sortDirection} onSort={sort} />
                {canConfigure ? <th>Drive 資料夾</th> : null}
                <th>還在營業</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((scope) => (
                  <tr key={scope.id}>
                    <td data-label="通路">
                      {/*
                        * 開關本身就說得出營業中與已停業，所以那兩個狀態不另開一欄重複。
                        * 只有「已封存」是開關表達不出來的——它會被 disable，但畫面上看
                        * 不出為什麼，所以標在名稱旁邊。
                        */}
                      <div className="cell-strong flex items-center gap-2">
                        {scope.name}
                        {scope.archivedAt ? <span className="status quiet">已封存</span> : null}
                      </div>
                      <div className="cell-sub">
                        {scope.externalName && scope.externalName !== scope.name ? `後台店名：${scope.externalName}` : scope.id}
                      </div>
                    </td>
                    <td data-label="種類"><span className="status quiet">{KIND_LABELS[scope.scopeKind]}</span></td>
                    <td data-label="來源"><span className="status quiet">{sourceLabel(scope.sourceType)}</span></td>
                    {canConfigure ? (
                      <td data-label="Drive 資料夾">
                        {scope.driveFolderUrl
                          ? <a href={scope.driveFolderUrl} target="_blank" rel="noreferrer">{scope.driveFolderName || "開啟資料夾"}</a>
                          : <span className="cell-sub">—</span>}
                      </td>
                    ) : null}
                    <td data-label="還在營業">
                      <Switch
                        checked={scope.active}
                        busy={saveScope.isPending}
                        disabled={Boolean(scope.archivedAt)}
                        onChange={(active) => toggleActive(scope, active)}
                        label={`${scope.name}還在營業——關掉就不再出現在報表執行頁與補登選單，歷史數字不受影響`}
                      />
                    </td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button
                          variant="icon"
                          icon="edit"
                          title="編輯通路"
                          aria-label={`編輯 ${scope.name}`}
                          onClick={() => setEditing({ scope })}
                        />
                        {scope.archivedAt ? (
                          <Button
                            variant="icon"
                            icon="history"
                            title="還原通路"
                            aria-label={`還原 ${scope.name}`}
                            disabled={saveScope.isPending}
                            onClick={() => restore(scope)}
                          />
                        ) : (
                          <Button
                            variant="icon"
                            icon="archive"
                            title="封存通路"
                            aria-label={`封存 ${scope.name}`}
                            disabled={archiveScope.isPending}
                            onClick={() => setArchiving(scope)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>

        {visible.length === 0 ? <p className="muted table-note">沒有符合條件的通路。</p> : null}
        {visible.length > 0 ? (
          <Pager
            page={currentPage}
            pageSize={pageSize}
            pageSizes={[10, 25, 50, 100]}
            totalPages={totalPages}
            totalLabel={`共 ${visible.length.toLocaleString("zh-TW")} 個通路`}
            onPage={setPage}
            onPageSize={(next) => { setPageSize(next); setPage(1); }}
          />
        ) : null}
      </Panel>

      {editing ? (
        <ScopeDialog scope={editing.scope} canConfigure={canConfigure} onClose={() => setEditing(null)} />
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title={`封存「${archiving.name}」？`}
          confirmLabel="封存"
          pending={archiveScope.isPending}
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            const target = archiving;
            setArchiving(null);
            archiveScope.mutate(target.id, {
              onSuccess: () => toast.show(`已封存「${target.name}」`),
            });
          }}
        >
          <p><strong>{archiving.name}</strong> 會從報表執行頁、補登選單與這張清單的預設檢視收起來。</p>
          <p className="muted">已匯入的出金與商品銷售不會被刪除，營運統計仍然算得到它；狀態篩選選「已封存」就找得回來。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
