import type { ChangeEvent, ReactNode } from "react";

/*
 * 權限與角色的勾選清單，角色編輯與使用者編輯兩個對話框共用。
 *
 * 22 個權限一列一個的話，對話框要捲兩倍以上才看得完，而右半邊整片空白。
 * 改成依模組分組的區塊 ＋ 兩欄排列：一眼看得到「這個角色碰得到哪幾個模組」，
 * 而不是一條沒有段落的清單。
 */

export function PermissionGroup({ legend, children }: { legend: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="m-0 rounded-card border border-soft-line px-3.5 pt-2.5 pb-3">
      <legend className="flex items-center gap-2 px-1.5 text-[13px] font-bold">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** 「3/9」讓人不用自己數就知道這一組勾了多少。 */
export function PermissionCount({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-soft-line px-[7px] py-px text-[11px] font-medium text-muted tabular-nums">{children}</span>;
}

/** 分組裡的說明文字。權限這種東西不解釋一下，人不會知道什麼時候該用。 */
export function PermissionHint({ children }: { children: ReactNode }) {
  return <p className="mx-1.5 mt-0.5 mb-2.5 text-[12.5px] text-muted">{children}</p>;
}

export function PermissionGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-x-3.5 gap-y-0.5">{children}</div>;
}

interface PermissionItemProps {
  label: ReactNode;
  /** 標在項目後面的補充，例如「來自角色」：說明為什麼這個勾不能取消。 */
  note?: ReactNode;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/** 整列可點，不是只有那顆 18px 的方塊。 */
export function PermissionItem({ label, note, title, checked, disabled = false, onChange }: PermissionItemProps) {
  return (
    <label
      className={`grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5 rounded-field px-2 py-1.5 text-[13px] ${disabled ? "cursor-default" : "cursor-pointer hover:bg-brand/5"} ${checked ? "font-medium text-brand-dark" : ""}`}
      title={title}
    >
      <input type="checkbox" className="m-0 size-[18px] cursor-pointer" checked={checked} disabled={disabled} onChange={onChange} />
      <span className={disabled ? "text-muted" : undefined}>
        {label}
        {note ? <small className="ml-1.5 text-[11px] font-normal text-muted">{note}</small> : null}
      </span>
    </label>
  );
}
