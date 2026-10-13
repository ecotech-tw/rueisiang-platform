import { useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
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
  const [leaveKind, setLeaveKind] = useState<"annual" | "grant" | "other">(leaveType?.leaveKind ?? "other");
  const [scheduleCheckRequired, setScheduleCheckRequired] = useState(Boolean(leaveType?.scheduleCheckRequired ?? 1));
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsedPayRate = Number(payRate);
    if (!name.trim()) { setMessage("請輸入假別名稱。"); return; }
    if (!Number.isFinite(parsedPayRate) || parsedPayRate < 0 || parsedPayRate > 100) { setMessage("預設給薪比例必須介於 0～100%。"); return; }
    setMessage(null);
    save.mutate({
      path: leaveType ? `/leave-types/${leaveType.id}` : "/leave-types",
      method: leaveType ? "PATCH" : "POST",
      values: { name: name.trim(), leaveKind, scheduleCheckRequired, defaultPayRatePpm: Math.round(parsedPayRate * 10_000) },
    }, { onSuccess: () => { (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    title={leaveType ? "編輯假別" : "新增假別"}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" tone={leaveType ? "info" : "success"} loading={save.isPending}>保存假別</Button></>}
  >
    <TextField label="假別名稱" hint="例如：特休、病假、事假；停用只會停止新申請，不刪除歷史資料。" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
    <SelectField label="額度規則" value={leaveKind} options={[{ value: "annual", label: "特休（使用週年制額度）" }, { value: "grant", label: "額度發放（HR 逐批發放）" }, { value: "other", label: "其他假別（不扣額度）" }]} onChange={(event) => { const next = event.target.value as "annual" | "grant" | "other"; setLeaveKind(next); if (next === "grant" && next !== leaveKind) setScheduleCheckRequired(false); }} hint="特休依週年政策給予；額度發放假別由 HR 指定有效期間與員工；其他假別不扣額度台帳。" />
    {leaveKind === "grant" ? <SelectField label="請假時數計算方式" value={scheduleCheckRequired ? "yes" : "no"} options={[{ value: "yes", label: "依班表計算" }, { value: "no", label: "依申請時數計算（補休）" }]} onChange={(event) => setScheduleCheckRequired(event.target.value === "yes")} hint="補休通常依申請時數計算；其他額度假別可選擇依班表計算。" /> : null}
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
      actions={canWrite ? <Button icon="plus" tone="success" mobileIconOnly onClick={() => setEditor("new")}>新增假別</Button> : undefined}
    />
    <Alert tone="info">請假申請在「申請與審核」處理；特休假別會扣除週年制額度，其他假別維持獨立規則。個別申請仍可保存當次核定比例。</Alert>
    {leaveTypes.error || toggle.error ? <Alert tone="danger">{leaveTypes.error?.message ?? toggle.error?.message}</Alert> : null}
    <Panel className="grows" title="假別主檔" description="停用取代刪除，避免破壞既有月度假勤與申請紀錄。">
      <DataTable><thead><tr><th>假別</th><th>額度規則</th><th>預設給薪比例</th><th>狀態</th><th>最近更新</th><th>操作</th></tr></thead><tbody>
        {rows.map((leaveType) => <tr key={leaveType.id}>
          <td data-label="假別"><strong>{leaveType.name}</strong></td>
          <td data-label="額度規則">{leaveType.leaveKind === "annual" ? "週年制特休" : leaveType.leaveKind === "grant" ? `HR 逐批發放・${leaveType.scheduleCheckRequired ? "依班表" : "依申請時數"}` : "其他假別"}</td>
          <td data-label="預設給薪比例">{payRateLabel(leaveType.defaultPayRatePpm)}</td>
          <td data-label="狀態"><StatusBadge tone={leaveType.active ? "success" : "neutral"}>{leaveType.active ? "啟用" : "停用"}</StatusBadge></td>
          <td data-label="最近更新">{timestampLabel(leaveType.updatedAt)}</td>
          <td data-label="操作"><div className="row-actions">{canWrite ? <><Button variant="secondary" icon="edit" tone="info" onClick={() => setEditor(leaveType)}>編輯</Button><Button variant="secondary" icon={leaveType.active ? "archive" : "check"} loading={toggle.isPending} onClick={() => toggle.mutate({ path: `/leave-types/${leaveType.id}/status`, method: "POST", values: { active: !leaveType.active } }, { onSuccess: () => void leaveTypes.refetch() })}>{leaveType.active ? "停用" : "啟用"}</Button></> : null}</div></td>
        </tr>)}
      </tbody></DataTable>
      {!rows.length ? <EmptyState>尚未建立假別，請先新增一個假別再建立請假申請。</EmptyState> : null}
    </Panel>
    {editor === "new" ? <LeaveTypeDialog onClose={() => { setEditor(null); void leaveTypes.refetch(); }} /> : null}
    {editor && editor !== "new" ? <LeaveTypeDialog leaveType={editor} onClose={() => { setEditor(null); void leaveTypes.refetch(); }} /> : null}
  </div>;
}
