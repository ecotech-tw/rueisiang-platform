/*
 * 敘薪的薪資項目與特殊上班日的補貼／加班規則共用「欄位標題／逐列編輯／底部新增」結構。
 * 欄寬各自不同，所以只共用外框、標題字與名稱格；每一列的 grid 由使用它的對話框自己寫。
 *
 * 手機版跟著 TextField／SelectField 的 stackedLabel="viewport" 一起看螢幕寬度：
 * 欄位標題收掉的同時，每個欄位才會自己補上標籤。
 */
export const SALARY_ITEMS = "grid gap-2.5";
export const SALARY_ITEMS_LABEL = "text-[13px] font-semibold text-ink";
export const SALARY_ITEMS_HEAD = "text-[12px] font-semibold text-muted max-[640px]:hidden";
/** 不能改的項目名稱（基本薪資、套用時的補貼名稱）做成跟輸入框一樣高的色塊，跟可編輯的列對齊。 */
export const SALARY_ITEM_NAME = "flex min-h-(--size-field) items-center rounded-field bg-canvas px-3.5 text-[14px] font-semibold text-ink";
export const SALARY_ITEMS_EMPTY = "col-span-full my-0.5 rounded-field bg-canvas px-3.5 py-3";
export const SALARY_ITEMS_FOOT = "flex flex-wrap items-center justify-between gap-3 border-t border-t-soft-line pt-3";
/** 手機版名稱欄獨占一行，其餘欄位排在下一行。 */
export const SALARY_ITEM_STACKED = "max-[640px]:items-start max-[640px]:gap-2 max-[640px]:[&>:first-child]:col-span-full";
