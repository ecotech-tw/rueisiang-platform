import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, SelectField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrManagementOptions } from "./api.js";

export function HrManagementScopes() {
  usePageTitle("HR 範圍授權");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:scope:read");
  const canWrite = permissions.has("hr:scope:write");
  const [userId, setUserId] = useState("");
  const [scopeId, setScopeId] = useState("");
  const query = useHrQuery<HrManagementOptions>("/management-scopes", canRead);
  const save = useHrWrite();
  const assigned = useMemo(
    () => new Set((query.data?.assignments ?? []).map((item) => `${item.userId}:${item.scopeId}`)),
    [query.data?.assignments],
  );

  if (!canRead) return <Alert tone="danger">你沒有檢視 HR 範圍授權的權限。</Alert>;

  function grant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId || !scopeId) return;
    save.mutate({ path: "/management-scopes", method: "POST", values: { userId, scopeId } }, {
      onSuccess: () => { setScopeId(""); void query.refetch(); },
    });
  }

  function revoke(targetUserId: string, targetScopeId: string) {
    if (!window.confirm("確定要收回這筆 HR 範圍授權嗎？收回後，對方將無法再檢視該櫃點所屬員工資料。")) return;
    save.mutate({
      path: `/management-scopes/${encodeURIComponent(targetUserId)}/${encodeURIComponent(targetScopeId)}`,
      method: "DELETE",
      values: {},
    }, { onSuccess: () => void query.refetch() });
  }

  const userOptions = (query.data?.users ?? []).map((user) => ({ value: user.id, label: `${user.name}（${user.email}）` }));
  const scopeOptions = (query.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }));

  return <div className="page">
    <PageHeader title="HR 範圍授權" description="範圍只決定可以管理哪些營運櫃點，不會自行授予 HR 功能權限；空白範圍也不代表全平台存取。" />
    <Panel title="新增管理範圍" description="先在角色或帳號權限中授予 HR 功能，再於此指定資料範圍。">
      {canWrite ? <form className="admin-form" onSubmit={grant}>
        <SelectField label="使用者" value={userId} onChange={(event) => setUserId(event.target.value)} options={[{ value: "", label: "請選擇啟用中的使用者" }, ...userOptions]} required />
        <SelectField label="營運櫃點" value={scopeId} onChange={(event) => setScopeId(event.target.value)} options={[{ value: "", label: "請選擇有效櫃點" }, ...scopeOptions]} required />
        <Button type="submit" loading={save.isPending} disabled={!userId || !scopeId || assigned.has(`${userId}:${scopeId}`)}>授予範圍</Button>
      </form> : <p className="muted">目前帳號只有檢視權限，不能修改範圍。</p>}
      {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    </Panel>
    <Panel title="目前授權" description="收回範圍不會刪除員工、任職或歷史稽核資料。">
      <div className="table-scroll"><table className="data-table"><thead><tr><th>使用者</th><th>櫃點</th><th>建立時間</th><th>操作</th></tr></thead><tbody>
        {(query.data?.assignments ?? []).map((item) => <tr key={`${item.userId}:${item.scopeId}`}>
          <td><div className="cell-strong">{item.userName}</div><div className="cell-sub">{item.userEmail}</div></td>
          <td>{item.scopeName}</td>
          <td className="cell-sub">{item.createdAt}</td>
          <td>{canWrite ? <Button variant="danger" onClick={() => revoke(item.userId, item.scopeId)}>收回</Button> : null}</td>
        </tr>)}
      </tbody></table></div>
      {query.isPending ? <p className="muted table-note">載入中…</p> : null}
      {query.data && !query.data.assignments.length ? <p className="muted table-note">尚未建立範圍授權。</p> : null}
    </Panel>
  </div>;
}
