import type { ReactNode } from "react";

/*
 * 只用來「看」的小膠囊：客人的標籤、使用者的角色、實際擁有的權限。
 *
 * 跟 Chip 分開：Chip 是一顆按鈕（篩選、切換、新增），這裡是一段標示，本身不能按。
 * 做成按鈕的話鍵盤要一顆一顆 Tab 過去，讀螢幕也會唸成「按鈕」，但按下去什麼都不會發生。
 */

/*
 * onRemove 與 removeLabel 要嘛都不給，要嘛一起給：× 鈕只有一個「×」字元，
 * 少了 removeLabel 讀螢幕只會唸「乘號，按鈕」，聽不出要移除哪一個。
 */
type TagProps = {
  /** 表格與清單裡的次要資訊用 subtle：小一號、不加粗，不搶同一格主要文字的視線。 */
  subtle?: boolean;
  children: ReactNode;
} & (
  | { onRemove?: undefined; removeLabel?: undefined }
  /** 出現 × 鈕，例如表單裡正在編輯的標籤。removeLabel 是它的 aria-label，例如「移除 VIP」。 */
  | { onRemove: () => void; removeLabel: string }
);

export function Tag({ subtle = false, onRemove, removeLabel, children }: TagProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${subtle ? "border-soft-line bg-canvas px-2 py-px text-[11px] font-normal" : "border-line bg-paper py-[3px] pr-1 pl-2.5 text-[12px] font-bold"}`}>
      {children}
      {onRemove ? (
        <button
          type="button"
          className="size-[18px] rounded-[50%] border-0 bg-soft-line p-0 leading-none text-muted hover:bg-brand hover:text-white"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/**
 * 一串 Tag。外距由使用的那一層決定（通常是接在主要文字下面的 mt-1）。
 * data-tag-list 給 DataTable 的手機卡片用：值那一欄是 grid item，不靠左的話這一串會被拉滿整格。
 */
export function TagList({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div data-tag-list="" className={`flex flex-wrap gap-1 ${className}`}>{children}</div>;
}
