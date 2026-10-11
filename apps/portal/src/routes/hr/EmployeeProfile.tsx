import { useEffect, useRef, useState } from "react";
import { HR_PROFILE_FIELDS, emptyHrPersonalData, type HrPersonalData, type HrProfileField } from "@rueisiang/db/hr-profile-fields";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type NamedOption, type Profile } from "./api.js";

import { EmployeePhoto } from "./EmployeePhoto.js";

type EditGroup = "basic" | "contact" | "company" | "reactivate";

function PersonalFields({ group, data, editing, onChange }: { group: "basic" | "contact"; data: HrPersonalData; editing: boolean; onChange: (key: keyof HrPersonalData, value: string) => void }) {
  return <>{HR_PROFILE_FIELDS.filter((field) => field.group === group).map((definition) => {
    const field: HrProfileField = definition;
    return editing ? field.options ? <SelectField key={field.key} label={field.label} value={data[definition.key]} options={[{ value: "", label: "未填寫" }, ...field.options.map((option) => ({ value: option, label: option }))]} onChange={(event) => onChange(definition.key, event.target.value)} /> : <TextField key={field.key} label={field.label} type={field.type ?? "text"} value={data[definition.key]} maxLength={field.maxLength ?? 100} {...(field.type === "number" ? { min: 0.01, max: 500, step: 0.01 } : {})} onChange={(event) => onChange(definition.key, event.target.value)} /> : <div key={field.key}><dt>{field.label}</dt><dd>{data[definition.key] || "—"}</dd></div>;
  })}</>;
}

export function EmployeeProfile({ profile, canWrite, onSaved }: { profile: Profile; canWrite: boolean; onSaved: () => void }) {
  const employment = profile.employments.find((job) => !job.archivedAt) ?? profile.employments[0];
  const active = Boolean(employment && !employment.archivedAt);
  const [editing, setEditing] = useState<EditGroup | null>(null);
  const [personal, setPersonal] = useState<HrPersonalData>(() => ({ ...emptyHrPersonalData(), ...profile.personalData }));
  const [values, setValues] = useState(() => ({ legalName: profile.employee.legalName, employeeNumber: profile.employee.employeeNumber, position: profile.employee.position, supervisorUserId: profile.employee.supervisorUserId ?? "", serviceStartOn: employment?.serviceStartOn ?? "" }));
  const [expectedRevision, setExpectedRevision] = useState(employment?.revision ?? 0);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const closeArchiveRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const save = useHrWrite();
  const archive = useHrWrite();
  const supervisors = useHrQuery<{ users: NamedOption[] }>(`/supervisor-candidates?exclude=${encodeURIComponent(profile.employee.userId ?? "")}`, canWrite && (editing === "company"));
  const pending = save.isPending || archive.isPending || photoBusy;
  const reset = () => {
    setPersonal({ ...emptyHrPersonalData(), ...profile.personalData });
    setValues({ legalName: profile.employee.legalName, employeeNumber: profile.employee.employeeNumber, position: profile.employee.position, supervisorUserId: profile.employee.supervisorUserId ?? "", serviceStartOn: employment?.serviceStartOn ?? "" });
    save.reset();
  };
  useEffect(() => {
    if (editing === null) { reset(); setExpectedRevision(employment?.revision ?? 0); }
  }, [profile, editing]);
  const begin = (group: EditGroup) => { reset(); setExpectedRevision(employment?.revision ?? 0); setEditing(group); };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employment || !profile.employee.userId || !editing) return;
    const personalData = editing === "basic" || editing === "contact" ? Object.fromEntries(HR_PROFILE_FIELDS.filter((field) => field.group === editing).map(({ key }) => [key, personal[key]])) : undefined;
    const restore = editing === "reactivate";
    save.mutate({
      path: restore ? "/employees" : `/employees/${encodeURIComponent(profile.employee.userId)}`,
      method: restore ? "POST" : "PATCH",
      values: { legalName: values.legalName, employeeNumber: values.employeeNumber, position: values.position, revision: expectedRevision,
        ...(restore ? { userId: profile.employee.userId, attendanceMode: employment.attendanceMode ?? "general" } : {}),
        ...(editing === "company" ? { ...(values.supervisorUserId !== (profile.employee.supervisorUserId ?? "") ? { supervisorUserId: values.supervisorUserId || null } : {}), ...(values.serviceStartOn ? { serviceStartOn: values.serviceStartOn } : {}) } : {}),
        ...(profile.personalData !== undefined && personalData ? { personalData } : {}),
      },
    }, { onSuccess: () => { setEditing(null); onSaved(); } });
  };
  const editButton = (group: EditGroup) => canWrite && active && editing === null ? <Button variant="secondary" className="hr-action-update" icon="edit" disabled={pending} onClick={() => begin(group)}>編輯</Button> : null;
  const actions = <div className="hr-employee-detail-form-actions"><Button variant="secondary" type="button" disabled={pending} onClick={() => { reset(); setEditing(null); }}>取消</Button><Button type="submit" icon="check" className="hr-action-update" loading={save.isPending}>{editing === "reactivate" ? "恢復在職" : "儲存資料"}</Button></div>;
  const error = save.error ? <Alert tone="danger">{save.error.message} 輸入內容仍保留；若資料已變更，請取消編輯並重新整理。</Alert> : null;
  const supervisorOptions = supervisors.data?.users ?? [];
  const currentSupervisor: NamedOption[] = profile.employee.supervisorUserId && !supervisorOptions.some((option) => option.id === profile.employee.supervisorUserId)
    ? [{ id: profile.employee.supervisorUserId, name: profile.employee.supervisorName ?? "目前主管" }]
    : [];
  const changePersonal = (key: keyof HrPersonalData, value: string) => setPersonal((current) => ({ ...current, [key]: value }));
  const savedPersonal = { ...emptyHrPersonalData(), ...profile.personalData };
  return <>
    <Panel id="employee-photo" title="員工大頭貼">
      {profile.personalData !== undefined && employment ? <EmployeePhoto employmentId={employment.id} revision={employment.revision} name={profile.employee.legalName} photo={profile.photo} canWrite={canWrite && active} disabled={editing !== null || save.isPending || archive.isPending} onBusyChange={setPhotoBusy} onSaved={onSaved} /> : <p className="muted">員工大頭貼僅限全平台 HR 管理者查看。</p>}
    </Panel>
    <Panel id="employee-basic" title="基本資料" actions={editButton("basic")}>
      {editing === "basic" ? <form className="hr-employee-detail-form" onSubmit={submit}><fieldset disabled={pending} className="field-grid hr-employee-detail-fields">
        <TextField label="中文姓名（身分證）" required maxLength={100} value={values.legalName} onChange={(event) => setValues({ ...values, legalName: event.target.value })} />
        <TextField label="員工編號" required maxLength={40} value={values.employeeNumber} onChange={(event) => setValues({ ...values, employeeNumber: event.target.value })} />
        {profile.personalData !== undefined ? <PersonalFields group="basic" data={personal} editing onChange={changePersonal} /> : null}
      </fieldset>{error}{actions}</form> : <dl className="hr-employee-profile-grid">
        <div><dt>中文姓名</dt><dd>{profile.employee.legalName}</dd></div><div><dt>員工編號</dt><dd>{profile.employee.employeeNumber}</dd></div>
        {profile.personalData !== undefined ? <PersonalFields group="basic" data={savedPersonal} editing={false} onChange={changePersonal} /> : null}
      </dl>}
      {profile.personalData === undefined ? <p className="muted">生日、證件與其他個資僅限全平台 HR 管理者查看。</p> : null}
    </Panel>
    <Panel id="employee-contact" title="聯絡資料" actions={profile.personalData !== undefined ? editButton("contact") : null}>
      {profile.personalData === undefined ? <p className="muted">聯絡資料僅限全平台 HR 管理者查看。</p> : editing === "contact" ? <form className="hr-employee-detail-form" onSubmit={submit}><fieldset disabled={pending} className="field-grid hr-employee-detail-fields"><PersonalFields group="contact" data={personal} editing onChange={changePersonal} /></fieldset>{error}{actions}</form> : <dl className="hr-employee-profile-grid"><PersonalFields group="contact" data={savedPersonal} editing={false} onChange={changePersonal} /></dl>}
    </Panel>
    <Panel id="employee-company" title="公司／任職資料" actions={editButton("company")}>
      {editing === "company" || editing === "reactivate" ? <form className="hr-employee-detail-form" onSubmit={submit}>
        {editing === "reactivate" ? <p className="muted">沿用原任職、服務年資與歷史資料；恢復後請確認出勤範圍。</p> : null}
        <fieldset disabled={pending} className="field-grid hr-employee-detail-fields">
          {editing === "reactivate" ? <><TextField label="中文姓名" required maxLength={100} value={values.legalName} onChange={(event) => setValues({ ...values, legalName: event.target.value })} /><TextField label="員工編號" required maxLength={40} value={values.employeeNumber} onChange={(event) => setValues({ ...values, employeeNumber: event.target.value })} /></> : null}
          <TextField label="職位" required maxLength={100} value={values.position} onChange={(event) => setValues({ ...values, position: event.target.value })} />
          {editing === "company" ? <><SelectField label="主管" value={values.supervisorUserId} searchable options={[{ value: "", label: "未指定" }, ...[...currentSupervisor, ...supervisorOptions].map((option) => ({ value: option.id, label: option.employeeNumber ? `${option.employeeNumber}・${option.name}` : option.name }))]} disabled={supervisors.isPending || Boolean(supervisors.error)} onChange={(event) => setValues({ ...values, supervisorUserId: event.target.value })} /><TextField label="服務年資起算日" type="date" value={values.serviceStartOn} required hint="供在職薪資計算使用；特休依第一筆有效月薪敘薪生效日計算。" onChange={(event) => setValues({ ...values, serviceStartOn: event.target.value })} /></> : null}
        </fieldset>{supervisors.error ? <Alert tone="danger">主管清單載入失敗，既有主管會保留。</Alert> : null}{error}{actions}
      </form> : <dl className="hr-employee-profile-grid">
        <div><dt>公司 Email（登入帳號）</dt><dd>{profile.employee.email || "—"}</dd></div><div><dt>帳號名稱</dt><dd>{profile.employee.accountName || "—"}</dd></div>
        <div><dt>職位</dt><dd>{employment?.position ?? profile.employee.position}</dd></div><div><dt>主管</dt><dd>{employment?.supervisorName ?? profile.employee.supervisorName ?? "未設定"}</dd></div>
        <div><dt>服務年資起算日</dt><dd>{employment?.serviceStartOn ?? "—"}</dd></div><div><dt>員工狀態</dt><dd><StatusBadge tone={active ? "success" : "neutral"}>{active ? "在職" : "未在職"}</StatusBadge></dd></div>
        <div><dt>帳號狀態</dt><dd>{profile.employee.userStatus === "active" ? "啟用中" : profile.employee.userStatus === "invited" ? "待啟用" : "已停用"}</dd></div>
      </dl>}
      <p className="muted">公司 Email 與帳號名稱由平台帳號管理；在職與帳號啟用狀態分開。</p>
      {canWrite && employment && editing === null ? <div className="hr-employee-detail-form-actions">{active ? <Button variant="danger" icon="archive" disabled={pending} onClick={() => { archive.reset(); setConfirmArchive(true); }}>設為未在職</Button> : <Button icon="plus" className="add-action" onClick={() => begin("reactivate")}>恢復在職</Button>}</div> : null}
    </Panel>
    {confirmArchive && employment ? <ConfirmDialog title="將員工設為未在職？" confirmLabel="設為未在職" pending={archive.isPending} closeRequestRef={closeArchiveRef} onCancel={() => setConfirmArchive(false)} onConfirm={() => archive.mutate({ path: `/employments/${employment.id}/archive`, method: "POST", values: { revision: employment.revision } }, { onSuccess: () => { (closeArchiveRef.current ?? ((afterClose?: () => void) => { setConfirmArchive(false); afterClose?.(); }))(onSaved); } })}>
      <p>這會將 <strong>{profile.employee.legalName}</strong> 移到未在職名單，不會刪除基本、聯絡、敘薪、保險與出勤紀錄；之後可恢復在職。</p>{archive.error ? <Alert tone="danger">{archive.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </>;
}
