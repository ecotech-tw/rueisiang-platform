import { useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type ReactNode, type Ref } from "react";

export { TableBulkActionMenu, type TableBulkActionOption } from "@rueisiang/ui";

interface TableCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> {
  ref?: Ref<HTMLInputElement>;
  /** 部分選取。HTML 沒有這個屬性，只能從 DOM 設，所以包在元件裡。 */
  indeterminate?: boolean;
  /** 聚焦時改用跟批次勾選欄同一種外框（TABLE_SELECT_COLUMN 由表格套上；表格外的勾選框用這個）。 */
  focusOutline?: boolean;
}

/** 表格勾選欄與全選列共用的勾選框。 */
export function TableCheckbox({ ref, indeterminate, focusOutline = false, ...props }: TableCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!, []);
  useEffect(() => {
    if (inputRef.current && indeterminate !== undefined) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input
    ref={inputRef}
    type="checkbox"
    className={`m-0 size-[18px] cursor-pointer accent-brand disabled:cursor-not-allowed ${focusOutline ? "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary" : ""}`}
    {...props}
  />;
}

/** 勾選框旁邊帶文字的全選標籤；點文字也能切換。 */
export function TableSelectAllLabel({ children }: { children: ReactNode }) {
  return <label className="inline-flex cursor-pointer items-center gap-2">{children}</label>;
}

const SELECT_COLUMN_FOCUS = "[&_tr>:first-child_input:focus-visible]:outline-2 [&_tr>:first-child_input:focus-visible]:outline-offset-2 [&_tr>:first-child_input:focus-visible]:outline-secondary";

/*
 * 批次模式的勾選欄：批次模式才有、而且一定是第一欄，所以用首欄選擇器套在 DataTable 的 className 上，
 * 只在批次模式加上去，格子不必另取 class。兩頁的欄寬與手機排法不同，用 layout 分開：
 * - inline：手機卡片照常把勾選格排在卡片裡，兩側改回 10px。桌機 th 的預設首欄 padding 會讓全選框
 *   的內容中心比資料列偏左，所以固定同一個 64px 的內容盒。
 * - corner：手機卡片把勾選框釘在左上角（8px ＋ 40px 點擊區），第二格改當卡片標題，左邊讓出 48px、
 *   右邊照 DataTable 的標題讓出 84px 給操作鈕。桌機欄寬 48px，勾選框靠格子裡的 40px 點擊區置中。
 */
export const TABLE_SELECT_COLUMN = {
  inline: `[&_tr>:first-child]:text-center min-[761px]:[&_tr>:first-child]:w-16 min-[761px]:[&_tr>:first-child]:min-w-16 min-[761px]:[&_tr>:first-child]:p-0 min-[761px]:[&_tr>:first-child>input]:block min-[761px]:[&_tr>:first-child>input]:mx-auto max-[760px]:[&_tr>:first-child]:px-2.5 ${SELECT_COLUMN_FOCUS}`,
  corner: `[&_tr>:first-child]:text-center [&_tr>:first-child]:w-12 min-[761px]:[&_tr>:first-child]:min-w-12 min-[761px]:[&_tr>:first-child]:p-0 ${SELECT_COLUMN_FOCUS} max-[760px]:[&_tbody_tr>td:first-child]:absolute max-[760px]:[&_tbody_tr>td:first-child]:top-2 max-[760px]:[&_tbody_tr>td:first-child]:left-2 max-[760px]:[&_tbody_tr>td:first-child]:block max-[760px]:[&_tbody_tr>td:first-child]:w-10 max-[760px]:[&_tbody_tr>td:first-child]:min-w-10 max-[760px]:[&_tbody_tr>td:first-child]:p-0 max-[760px]:[&_tbody_tr>td:first-child]:border-0 max-[760px]:[&_tbody_tr>td:first-child]:m-0 max-[760px]:[&_tbody_tr>td:nth-child(2)]:order-1 max-[760px]:[&_tbody_tr>td:nth-child(2)]:block max-[760px]:[&_tbody_tr>td:nth-child(2)]:w-full max-[760px]:[&_tbody_tr>td:nth-child(2)]:pt-0 max-[760px]:[&_tbody_tr>td:nth-child(2)]:pr-[84px] max-[760px]:[&_tbody_tr>td:nth-child(2)]:pb-2 max-[760px]:[&_tbody_tr>td:nth-child(2)]:pl-12 max-[760px]:[&_tbody_tr>td:nth-child(2)]:mb-1.5 max-[760px]:[&_tbody_tr>td:nth-child(2)]:border-b max-[760px]:[&_tbody_tr>td:nth-child(2)]:border-soft-line max-[760px]:[&_tbody_tr>td:nth-child(2)]:before:hidden`,
} as const;

/*
 * 手機卡片沒有表頭，全選框改放在表格上方的一列。
 * - divided：自己一列、下緣分隔線，跟卡片分成兩個區塊（薪資發放紀錄）。
 * - plain：不帶分隔線，只跟卡片隔 8px，勾選框聚焦時跟表格裡的勾選框同一種外框（申請與審核）。
 */
const MOBILE_SELECT_ALL = {
  divided: { row: "hidden max-[760px]:flex max-[760px]:flex-none max-[760px]:border-b max-[760px]:border-b-soft-line max-[760px]:px-3.5 max-[760px]:py-2", focusOutline: false },
  plain: { row: "hidden max-[760px]:flex max-[760px]:items-center max-[760px]:mb-2", focusOutline: true },
} as const;

interface TableMobileSelectAllProps {
  variant: keyof typeof MOBILE_SELECT_ALL;
  inputRef?: Ref<HTMLInputElement>;
  checked: boolean;
  disabled?: boolean;
  "aria-label": string;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

/** 手機版的「全選本頁」列；桌機的全選框在勾選欄的表頭。 */
export function TableMobileSelectAll({ variant, inputRef, checked, disabled, "aria-label": ariaLabel, onChange, children }: TableMobileSelectAllProps) {
  const skin = MOBILE_SELECT_ALL[variant];
  return <div className={skin.row}>
    <TableSelectAllLabel>
      <TableCheckbox ref={inputRef} focusOutline={skin.focusOutline} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={ariaLabel} />
      <span>{children}</span>
    </TableSelectAllLabel>
  </div>;
}
