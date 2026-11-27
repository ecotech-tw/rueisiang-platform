import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useAccountingQuery, type ExpenseEditRecord } from "./api.js";

/*
 * 報帳單的修改紀錄（送件人改的、會計改的），跟員工端看到的是同一份。沒改過就整塊不出現。
 */
export function ExpenseHistory({ expenseId, submitterName }: { expenseId: string; submitterName: string }) {
  const query = useAccountingQuery<{ history: ExpenseEditRecord[] }>(`/expenses/${encodeURIComponent(expenseId)}/history`);
  const history = query.data?.history ?? [];
  if (!history.length) return null;
  return <section className="grid gap-2">
    <h3 className="m-0 text-[13px] font-semibold text-muted">修改紀錄</h3>
    <ol className="m-0 grid list-none gap-3 p-0">
      {history.map((record) => <li key={record.id} className="grid gap-1 rounded-[12px] bg-canvas px-3 py-2.5">
        <span className="text-[12px] text-muted tabular-nums">{`${taipeiMinuteFromUtcWallClock(record.at)}・${record.editor === "reviewer" ? `會計 ${record.actorName}` : `送件人 ${submitterName}`}修改`}</span>
        <ul className="m-0 grid list-none gap-0.5 p-0 text-[14px]">
          {record.changes.map((change) => <li key={change.field} className="wrap-anywhere">{`${change.label}：${change.from} → ${change.to}`}</li>)}
        </ul>
      </li>)}
    </ol>
  </section>;
}
