import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useHrQuery, type ExpenseEditRecord } from "./api.js";

/*
 * 報帳單的修改紀錄：送件人自己改的、會計改的都在這裡，一筆一筆列出哪個欄位從什麼改成什麼。
 * 會計改過的單員工會收到通知，點進來就看得到改了什麼；沒改過就整塊不出現。
 */
export function ExpenseHistory({ expenseId }: { expenseId: string }) {
  const query = useHrQuery<{ history: ExpenseEditRecord[] }>(`/me/expenses/${encodeURIComponent(expenseId)}/history`);
  const history = query.data?.history ?? [];
  if (!history.length) return null;
  return <section className="grid gap-2">
    <h3 className="m-0 text-[13px] font-semibold text-muted">修改紀錄</h3>
    <ol className="m-0 grid list-none gap-3 p-0">
      {history.map((record) => <li key={record.id} className="grid gap-1 rounded-[12px] bg-canvas px-3 py-2.5">
        <span className="text-[12px] text-muted tabular-nums">{`${taipeiMinuteFromUtcWallClock(record.at)}・${record.editor === "reviewer" ? `會計 ${record.actorName}` : "你"}修改`}</span>
        <ul className="m-0 grid list-none gap-0.5 p-0 text-[14px]">
          {record.changes.map((change) => <li key={change.field} className="wrap-anywhere">{`${change.label}：${change.from} → ${change.to}`}</li>)}
        </ul>
      </li>)}
    </ol>
  </section>;
}
