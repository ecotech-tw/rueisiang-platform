import type { ChangeEventHandler, ReactNode } from "react";
import { Icon } from "../../shell/icons.js";

/*
 * 小香的工具清單：Sandbox、LINE channel、單一對話的勾選對話框，與設定頁的狀態列都是同一種列，
 * 外觀只在這裡寫一次。
 */
const TOOL_ROW = "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-[10px] border border-line px-3 py-[11px] hover:bg-canvas";

export function ToolList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2">{children}</div>;
}

/** 工具名稱下方的補充說明，一行一個。 */
export function ToolNote({ children }: { children: ReactNode }) {
  return <small className="mt-0.5 block text-[12px] text-muted">{children}</small>;
}

function ToolText({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <span>
      <strong className="block">{label}</strong>
      {children}
    </span>
  );
}

interface ToolOptionProps {
  label: ReactNode;
  /** `<ToolNote>` 組成的說明。 */
  children: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  /** 列尾的狀態標籤。 */
  trailing?: ReactNode;
}

/** 可勾選的一列：整列都是 label，點哪裡都會切換勾選。 */
export function ToolOption({ label, children, checked, disabled, onChange, trailing }: ToolOptionProps) {
  return (
    <label className={TOOL_ROW}>
      <span className="inline-flex items-center gap-2 text-secondary">
        <input type="checkbox" className="mt-[3px] accent-brand" checked={checked} disabled={disabled} onChange={onChange} />
        <Icon name="widgets" className="size-[19px]" />
      </span>
      <ToolText label={label}>{children}</ToolText>
      {trailing}
    </label>
  );
}

/** 設定頁的一列：沒有勾選框，列尾放狀態下拉。 */
export function ToolStatusRow({ label, children, control }: { label: ReactNode; children: ReactNode; control: ReactNode }) {
  return (
    <div className={TOOL_ROW}>
      <Icon name="widgets" />
      <ToolText label={label}>{children}</ToolText>
      {control}
    </div>
  );
}
