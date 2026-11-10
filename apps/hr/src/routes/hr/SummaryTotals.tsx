import type { ReactNode } from "react";

// 薪資明細與我的假勤共用的三格合計：最後一格是結果（實領、剩餘），用色調容器標出來。
export function SummaryTotals({ items }: { items: Array<{ label: ReactNode; value: ReactNode; emphasis?: boolean }> }) {
  return <div className="grid grid-cols-3 gap-2 max-[760px]:gap-1.5">{items.map((item, index) => <div key={index} className={`grid min-w-0 gap-[5px] rounded-[12px] p-3 max-[760px]:px-2 max-[760px]:py-2.5 ${item.emphasis ? "bg-brand-soft" : "bg-canvas"}`}>
    <span className="text-[12px] font-bold text-muted">{item.label}</span>
    <strong className={`overflow-hidden text-ellipsis whitespace-nowrap tabular-nums ${item.emphasis ? "text-[16px] text-brand-dark max-[760px]:text-[14px]" : "text-[14px] max-[760px]:text-[12px]"}`}>{item.value}</strong>
  </div>)}</div>;
}
