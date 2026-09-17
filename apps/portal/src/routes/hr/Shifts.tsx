import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { shiftTimeRange, useHrQuery, useHrWrite, type HrShiftsResponse, type ScheduleScope } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function ShiftDialog({ scopes, defaultScopeId, onClose, onCreated }: { scopes: ScheduleScope[]; defaultScopeId: string; onClose: () => void; onCreated: (name: string) => void }) {
  const [scopeId, setScopeId] = useState(defaultScopeId);
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const save = useHrWrite();
  // 班別一律當天上下班；結束早於開始多半是打錯，送出前就擋，不必等後端回一句看不出錯在哪的訊息。
  const invalidRange = Boolean(startTime && endTime && endTime <= startTime);
  return <Dialog title="新增班別" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (invalidRange) return;
    save.mutate({ path: "/shift-templates", method: "POST", values: { scopeId, name, startTime, endTime } }, { onSuccess: () => onCreated(name.trim()) });
  } }} actions={<Button type="submit" loading={save.isPending} disabled={!scopeId || invalidRange}>建立班別</Button>}>
    <SelectField label="營運據點" value={scopeId} options={scopes.map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => setScopeId(event.target.value)} />
    <TextField label="班別名稱" required maxLength={100} placeholder="例如：早班" value={name} onChange={(event) => setName(event.target.value)} />
    <div className="form-grid two">
      <TextField label="開始時間" type="time" required value={startTime} onChange={(event) => setStartTime(event.target.value)} />
      <TextField label="結束時間" type="time" required value={endTime} onChange={(event) => setEndTime(event.target.value)} />
    </div>
    {invalidRange ? <Alert tone="danger">結束時間必須晚於開始時間。</Alert> : null}
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

export function HrShifts() {
  usePageTitle("班別管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const toast = useToast();
  const shifts = useHrQuery<HrShiftsResponse>("/shift-templates", canRead);
  const [scopeId, setScopeId] = useState("all");
  const [creating, setCreating] = useState(false);
  const data = shifts.data;

  const scopeNames = useMemo(() => new Map((data?.scopes ?? []).map((scope) => [scope.id, scope.name])), [data?.scopes]);
  const rows = useMemo(() => {
    // 依店的顯示順序排，同一家店再依上班時間排：早班在晚班前面，讀起來才像一天的順序。
    const order = new Map((data?.scopes ?? []).map((scope, index) => [scope.id, index]));
    return (data?.shifts ?? [])
      .filter((shift) => scopeId === "all" || shift.scopeId === scopeId)
      .sort((a, b) => (order.get(a.scopeId) ?? 0) - (order.get(b.scopeId) ?? 0) || a.startSecond - b.startSecond);
  }, [data, scopeId]);

  if (!canRead) return <Alert tone="danger">你沒有檢視班別的權限。</Alert>;
  if (shifts.isPending) return <HrPageSkeleton variant="table" />;
  if (shifts.error || !data) return <div className="page"><Alert tone="danger">{shifts.error?.message ?? "班別資料載入失敗。"}</Alert></div>;

  const defaultScopeId = scopeId === "all" ? data.scopes[0]?.id ?? "" : scopeId;
  return <div className="page fills">
    <PageHeader title="班別管理" actions={canWrite ? <Button icon="plus" className="add-action" disabled={!data.scopes.length} onClick={() => setCreating(true)}>新增班別</Button> : null} />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <FilterSelect label="營運據點" value={scopeId} onChange={(event) => setScopeId(event.target.value)} options={[{ value: "all", label: "全部營運據點" }, ...data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))]} />
      </form>
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>營運據點</th><th>班別</th><th className="numeric">上班時間</th>
      </tr></thead><tbody>
        {rows.map((shift) => <tr key={`${shift.scopeId}:${shift.versionId}`}>
          <td data-label="營運據點">{scopeNames.get(shift.scopeId) ?? shift.scopeId}</td>
          <td data-label="班別"><span className="cell-strong">{shift.name}</span></td>
          <td data-label="上班時間" className="numeric">{shiftTimeRange(shift)}</td>
        </tr>)}
      </tbody></table></div>
      {!rows.length ? <p className="muted table-note">{scopeId === "all" ? "還沒有任何班別。先新增一個，排班月曆才選得到。" : `${scopeNames.get(scopeId) ?? "這個據點"}還沒有班別。先新增一個，排班月曆才選得到。`}</p> : null}
    </Panel>
    {creating ? <ShiftDialog scopes={data.scopes} defaultScopeId={defaultScopeId} onClose={() => setCreating(false)} onCreated={(name) => {
      setCreating(false);
      toast.show(`已新增班別「${name}」。`);
      void shifts.refetch();
    }} /> : null}
  </div>;
}
