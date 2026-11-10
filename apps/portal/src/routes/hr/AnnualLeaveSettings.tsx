import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Page, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, type HrAnnualLeaveBracket, type HrAnnualLeavePolicy } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function PolicyStat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="grid gap-1 rounded-[16px] bg-brand/6 px-4 py-[15px]"><span className="text-[12px] text-muted">{label}</span><strong className="text-[17px]">{value}</strong><small className="mt-[3px] block text-[12px] leading-[1.45] text-muted">{note}</small></div>;
}

function Principle({ title, children }: { title: string; children: string }) {
  return <div className="grid gap-1.5 rounded-[16px] bg-paper/42 px-4 py-[15px] [box-shadow:0_0_0_1px_--alpha(var(--color-ink)/6%)_inset]"><strong className="text-[14px]">{title}</strong><span className="text-[13px] leading-[1.6] text-muted">{children}</span></div>;
}

export function HrAnnualLeaveSettings() {
  usePageTitle("特休政策");
  const navigate = useNavigate();
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const policy = useHrQuery<{ policy: HrAnnualLeavePolicy; brackets: HrAnnualLeaveBracket[] }>("/annual-leave/policy", canRead, { keepPreviousData: false });

  if (!canRead) return <Alert tone="danger">特休政策僅限全平台 HR 管理者查看。</Alert>;
  if (policy.isPending) return <HrPageSkeleton variant="table" />;

  const current = policy.data?.policy;
  const brackets = policy.data?.brackets ?? [];
  return <Page>
    <PageHeader
      title="特休政策"
      description="公司共用的週年制規則與年資級距；只有月薪制員工會自動取得特休，員工目前可用額度請回到「特休額度」查看。"
      actions={<Button variant="secondary" icon="calendar" onClick={() => navigate("/hr/annual-leave")}>回到特休額度</Button>}
    />
    {policy.error ? <Alert tone="danger">{policy.error.message}</Alert> : null}
    {current ? <>
      <Panel title="目前生效版本" description="政策版本只新增、不覆寫已建立的歷史額度。">
        <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[620px]:grid-cols-1">
          <PolicyStat label="版本" value={`v${current.versionNumber}`} note={`自 ${current.validFrom} 起生效`} />
          <PolicyStat label="週期基準" value="週年制" note="依服務年資與首筆月薪生效日的較晚者計算" />
          <PolicyStat label="給薪日工時" value={`${(current.dailyMinutes / 60).toFixed(1)} 小時`} note={`最小單位 ${(current.minimumUnitMinutes / 60).toFixed(1)} 小時`} />
          <PolicyStat label="未休處理" value={current.carryoverAllowed ? "依政策遞延" : "不自動遞延"} note="每期額度獨立使用" />
        </div>
      </Panel>
      <Panel title="年資級距" description="額度依員工取得額度時的年資套用；10 年以上級距由政策資料列保存。">
        <DataTable className="[&_td:nth-child(2)]:tabular-nums [&_td:nth-child(3)]:tabular-nums"><thead><tr><th>適用年資</th><th>給予天數</th><th>換算額度</th></tr></thead><tbody>
          {brackets.map((bracket) => <tr key={bracket.id}><td>{bracket.label}</td><td><strong>{bracket.entitledDays} 日</strong></td><td>{(bracket.entitledDays * current.dailyMinutes / 60).toFixed(1)} 小時</td></tr>)}
        </tbody></DataTable>
      </Panel>
      <Panel title="套用原則" description="申請與額度頁只呈現結果；規則集中在本頁供 HR 查核。">
        <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-1">
          <Principle title="月薪制才取得">沒有有效月薪敘薪版本不建立額度；日薪轉月薪時從月薪生效日自動開始。</Principle>
          <Principle title="核准才扣額度">待審與駁回申請不會扣除；取消已核准申請會留下反向紀錄。</Principle>
          <Principle title="不可跨期挪用">每個週期獨立使用，跨週年申請必須拆成不同申請。</Principle>
        </div>
      </Panel>
    </> : null}
  </Page>;
}
