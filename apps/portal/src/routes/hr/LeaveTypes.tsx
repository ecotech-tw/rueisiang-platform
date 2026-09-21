import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrLeaveType } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function payRateLabel(ratePpm: number) {
  return `${(ratePpm / 10_000).toFixed(2)}%`;
}

function timestampLabel(value: string) {
  return value.replace("T", " ").slice(0, 16) || "—";
}

function LeaveTypeDialog({ leaveType, onClose }: { leaveType?: HrLeaveType; onClose: () => void }) {
  const [name, setName] = useState(leaveType?.name ?? "");
  const [payRate, setPayRate] = useState(String((leaveType?.defaultPayRatePpm ?? 1_000_000) / 10_000));
  const [leaveKind, setLeaveKind] = useState<"annual" | "other">(leaveType?.leaveKind ?? "other");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsedPayRate = Number(payRate);
    if (!name.trim()) { setMessage("請輸入假別名稱。"); return; }
    if (!Number.isFinite(parsedPayRate) || parsedPayRate < 0 || parsedPayRate > 100) { setMessage("預設給薪比例必須介於 0～100%。"); return; }
    setMessage(null);
    save.mutate({
      path: leaveType ? `/leave-types/${leaveType.id}` : "/leave-types",
      method: leaveType ? "PATCH" : "POST",
      values: { name: name.trim(), leaveKind, defaultPayRatePpm: Math.round(parsedPayRate * 10_000) },
    }, { onSuccess: onClose });
  }

  return <Dialog
    title={leaveType ? "編輯假別" : "新增假別"}
    onClose={onClose}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" loading={save.isPending}>保存假別</Button></>}
  >
    <TextField label="假別名稱" hint="例如：特休、病假、事假；停用只會停止新申請，不刪除歷史資料。" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
    <SelectField label="額度規則" value={leaveKind} options={[{ value: "annual", label: "特休（使用週年制額度）" }, { value: "other", label: "其他假別（獨立規則）" }]} onChange={(event) => setLeaveKind(event.target.value as "annual" | "other")} hint="特休由公司共用政策自動給予；其他假別不會扣特休台帳。" />
    <TextField label="預設給薪比例（%）" type="number" min="0" max="100" step="0.01" required value={payRate} onChange={(event) => setPayRate(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrLeaveTypes() {
  usePageTitle("假別管理");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canWrite = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const leaveTypes = useHrQuery<{ leaveTypes: HrLeaveType[] }>("/leave-types", canRead, { keepPreviousData: false });
  const toggle = useHrWrite();
  const [editor, setEditor] = useState<"new" | HrLeaveType | null>(null);
  const rows = leaveTypes.data?.leaveTypes ?? [];

  if (!canRead) return <Alert tone="danger">假別管理僅限全平台 HR 管理者查看。</Alert>;
  if (leaveTypes.isPending) return <HrPageSkeleton variant="table" />;

  return <div className="page fills hr-leave-types-page">
    <PageHeader
      title="假別管理"
      description="管理請假申請與月度假勤登記共用的假別主檔；停用假別會保留歷史資料，不再出現在新的申請與登記中。"
      actions={canWrite ? <Button icon="plus" onClick={() => setEditor("new")}>新增假別</Button> : undefined}
    />
    <Alert tone="info">請假申請在「申請與審核」處理；特休假別會扣除週年制額度，其他假別維持獨立規則。個別申請仍可保存當次核定比例。</Alert>
    {leaveTypes.error || toggle.error ? <Alert tone="danger">{leaveTypes.error?.message ?? toggle.error?.message}</Alert> : null}
    <Panel className="grows" title="假別主檔" description="停用取代刪除，避免破壞既有月度假勤與申請紀錄。">
      <div className="table-scroll"><table className="data-table"><thead><tr><th>假別</th><th>額度規則</th><th>預設給薪比例</th><th>狀態</th><th>最近更新</th><th>操作</th></tr></thead><tbody>
        {rows.map((leaveType) => <tr key={leaveType.id}>
          <td data-label="假別"><strong>{leaveType.name}</strong></td>
          <td data-label="額度規則">{leaveType.leaveKind === "annual" ? "週年制特休" : "其他假別"}</td>
          <td data-label="預設給薪比例">{payRateLabel(leaveType.defaultPayRatePpm)}</td>
          <td data-label="狀態"><StatusBadge tone={leaveType.active ? "success" : "neutral"}>{leaveType.active ? "啟用" : "停用"}</StatusBadge></td>
          <td data-label="最近更新">{timestampLabel(leaveType.updatedAt)}</td>
          <td data-label="操作"><div className="row-actions">{canWrite ? <><Button variant="secondary" icon="edit" onClick={() => setEditor(leaveType)}>編輯</Button><Button variant="secondary" icon={leaveType.active ? "archive" : "check"} loading={toggle.isPending} onClick={() => toggle.mutate({ path: `/leave-types/${leaveType.id}/status`, method: "POST", values: { active: !leaveType.active } }, { onSuccess: () => void leaveTypes.refetch() })}>{leaveType.active ? "停用" : "啟用"}</Button></> : null}</div></td>
        </tr>)}
      </tbody></table></div>
      {!rows.length ? <p className="empty-state">尚未建立假別，請先新增一個假別再建立請假申請。</p> : null}
    </Panel>
    {editor === "new" ? <LeaveTypeDialog onClose={() => { setEditor(null); void leaveTypes.refetch(); }} /> : null}
    {editor && editor !== "new" ? <LeaveTypeDialog leaveType={editor} onClose={() => { setEditor(null); void leaveTypes.refetch(); }} /> : null}
  </div>;
}
