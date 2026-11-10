import { Button } from "../../ui/index.js";

interface PeriodStep { label: string; disabled?: boolean; onClick: () => void }

// 打卡紀錄（月）與請假紀錄（年）共用同一條切換列；className 只給外層排版用。
export function PeriodToolbar({ label, previous, next, className = "" }: { label: string; previous: PeriodStep; next: PeriodStep; className?: string }) {
  return <div className={`flex items-center justify-between gap-2 border-b border-b-soft-line pb-2.5 ${className}`}>
    <Button variant="icon" icon="chevronLeft" aria-label={previous.label} disabled={previous.disabled} onClick={previous.onClick} />
    <strong className="text-[16px]">{label}</strong>
    <Button variant="icon" icon="chevronRight" aria-label={next.label} disabled={next.disabled} onClick={next.onClick} />
  </div>;
}
