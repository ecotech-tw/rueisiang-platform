import { Link } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Panel } from "../../ui/index.js";
import { useHrQuery } from "./api.js";

export function HrWork() {
  usePageTitle("工作");
  const scheduleScopes = useHrQuery<{ scopes: Array<{ id: string; name: string }> }>("/me/schedule-scopes");
  const items = [
    ...(scheduleScopes.data?.scopes.length ? [{ to: "/scheduling", label: "排班", description: "選擇據點、查看班表與快速排班", icon: "calendar" as const }] : []),
    { to: "/forms", label: "表單申請", description: "請假、加班、補打卡與申請紀錄", icon: "report" as const },
  ];
  return <div className="page grid gap-3 [&>*+*]:!mt-0">
    <h1 className="m-0 text-xl">工作</h1>
    <p className="m-0 text-sm text-muted">可使用的工作項目集中在這裡。</p>
    {scheduleScopes.error ? <Alert tone="danger">排班據點載入失敗，請重新整理後再試。</Alert> : null}
    <Panel density="compact">
      <div className="grid gap-1">
        {items.map((item) => <Link key={item.to} to={item.to} className="flex min-h-20 items-center gap-3 rounded-[calc(var(--radius-card)-8px)] px-3 py-2 text-ink transition-[background-color,scale] duration-150 ease-out hover:bg-brand/7 active:scale-[.96] focus-visible:outline-2 focus-visible:outline-secondary motion-reduce:transition-none motion-reduce:active:scale-100">
          <span className="shrink-0 text-brand-dark"><Icon name={item.icon} weight="semibold" className="size-6" /></span>
          <span className="grid min-w-0 gap-1"><strong className="font-semibold">{item.label}</strong><span className="text-sm text-muted">{item.description}</span></span>
          <span className="ml-auto shrink-0 text-muted"><Icon name="chevronRight" weight="semibold" className="size-6" /></span>
        </Link>)}
      </div>
    </Panel>
  </div>;
}
