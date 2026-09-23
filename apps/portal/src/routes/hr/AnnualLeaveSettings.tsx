import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, type HrAnnualLeaveBracket, type HrAnnualLeavePolicy } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

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
  return <div className="page hr-annual-settings-page">
    <PageHeader
      title="特休政策"
      description="公司共用的週年制規則與年資級距；員工目前可用額度請回到「特休額度」查看。"
      actions={<Button variant="secondary" icon="calendar" onClick={() => navigate("/hr/annual-leave")}>回到特休額度</Button>}
    />
    {policy.error ? <Alert tone="danger">{policy.error.message}</Alert> : null}
    {current ? <>
      <Panel title="目前生效版本" description="政策版本只新增、不覆寫已建立的歷史額度。">
        <div className="hr-annual-settings-overview">
          <div><span>版本</span><strong>v{current.versionNumber}</strong><small>自 {current.validFrom} 起生效</small></div>
          <div><span>週期基準</span><strong>週年制</strong><small>依服務年資起算日計算</small></div>
          <div><span>給薪日工時</span><strong>{(current.dailyMinutes / 60).toFixed(1)} 小時</strong><small>最小單位 {(current.minimumUnitMinutes / 60).toFixed(1)} 小時</small></div>
          <div><span>未休處理</span><strong>{current.carryoverAllowed ? "依政策遞延" : "不自動遞延"}</strong><small>每期額度獨立使用</small></div>
        </div>
      </Panel>
      <Panel title="年資級距" description="額度依員工取得額度時的年資套用；10 年以上級距由政策資料列保存。">
        <div className="table-scroll"><table className="data-table hr-annual-policy-table"><thead><tr><th>適用年資</th><th>給予天數</th><th>換算額度</th></tr></thead><tbody>
          {brackets.map((bracket) => <tr key={bracket.id}><td>{bracket.label}</td><td><strong>{bracket.entitledDays} 日</strong></td><td>{(bracket.entitledDays * current.dailyMinutes / 60).toFixed(1)} 小時</td></tr>)}
        </tbody></table></div>
      </Panel>
      <Panel title="套用原則" description="申請與額度頁只呈現結果；規則集中在本頁供 HR 查核。">
        <div className="hr-annual-principles"><div><strong>依任職年資起算</strong><span>以每筆 employment 的服務年資起算日建立週年期別。</span></div><div><strong>核准才扣額度</strong><span>待審與駁回申請不會扣除；取消已核准申請會留下反向紀錄。</span></div><div><strong>不可跨期挪用</strong><span>每個週期獨立使用，跨週年申請必須拆成不同申請。</span></div></div>
      </Panel>
    </> : null}
  </div>;
}
