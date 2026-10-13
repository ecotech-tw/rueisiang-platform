import { Button } from "../../ui/index.js";

export function HrBackBar({ label, disabled = false, onBack }: { label: string; disabled?: boolean; onBack: () => void }) {
  return <div className="sticky top-0 z-10 flex h-12 items-center border-b border-soft-line bg-canvas/94 backdrop-blur-[10px] max-[760px]:-mx-3.5 max-[760px]:px-3.5" aria-label="返回導覽">
    <Button variant="text" icon="chevronLeft" aria-label={label} disabled={disabled} onClick={onBack}>{label}</Button>
  </div>;
}
