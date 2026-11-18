import type { FormHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { defaultUnless } from "@rueisiang/ui";

export { Field, FieldHint, Input, InputSkin, SelectField, Textarea, TextField } from "@rueisiang/ui";

/*
 * auto：欄寬至少 180px，放得下幾欄就排幾欄。
 * 3：三個窄欄位（數量、單位、安全庫存）。auto-fit 在對話框的寬度下只排得下兩欄，第三個會
 *    自己掉到下一列、旁邊空一大格，這種一組的數字欄位就明講要三欄。
 * 2：成對的欄位（開始／結束），窄螢幕收成一欄。
 */
const FIELD_GRID_COLUMNS = {
  auto: "grid-cols-[repeat(auto-fit,minmax(180px,1fr))]",
  2: "grid-cols-2 max-[560px]:grid-cols-1",
  3: "grid-cols-3",
} as const;

/**
 * 並排的欄位。
 *
 * 子層的 Field 要能縮到比內容窄，不然一個長的選項或 placeholder 就會把整欄撐開。
 * `as="fieldset"` 給整組要一起停用的表單用，瀏覽器預設的框線與內距在這裡清掉。
 */
export function FieldGrid({ columns = "auto", as = "div", disabled, className = "", children }: {
  columns?: keyof typeof FIELD_GRID_COLUMNS;
  as?: "div" | "fieldset";
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = `grid ${FIELD_GRID_COLUMNS[columns]} ${defaultUnless(className, "gap-", "gap-4")} [&>[data-field]]:min-w-0 ${className}`.trim();
  if (as === "fieldset") return <fieldset disabled={disabled} className={`m-0 min-w-0 border-0 p-0 ${classes}`}>{children}</fieldset>;
  return <div className={classes}>{children}</div>;
}

/**
 * 排成一列、放不下就換行的欄位與按鈕（邀請信箱＋送出、改名輸入框＋儲存）。
 *
 * 有 Field 的那種排要底部對齊：Field 是「標籤在上、輸入框在下」兩層，旁邊的按鈕只有一層，
 * 置中的話按鈕會對到整塊 Field 的中線、浮在輸入框上方。條件寫成「有 Field 直接子層」而不是
 * 一律底部對齊，因為沒有 Field 的排（純文字標籤＋膠囊）底部對齊反而會讓文字比膠囊低 7px。
 */
export function FormRow({ as: Tag = "div", className = "", children, ...props }: Omit<FormHTMLAttributes<HTMLFormElement>, "className"> & {
  as?: "div" | "form";
  className?: string;
  children: ReactNode;
}) {
  const classes = `flex flex-wrap items-center gap-2.5 has-[>[data-field]]:items-end ${className}`.trim();
  if (Tag === "form") return <form {...props} className={classes}>{children}</form>;
  return <div {...(props as HTMLAttributes<HTMLDivElement>)} className={classes}>{children}</div>;
}

/**
 * 面板內容中間的 FormRow 跟上一塊隔 16px；直接接在面板標題列後面時，距離由標題列的下距負責，不再疊加。
 * 上面那塊常是有條件才出現的提示（例如「尚未建立通路」），所以要看實際的相鄰關係，不能寫死。
 */
export const FORM_ROW_SPACING = "mt-4 [[data-panel-head]+&]:mt-0";

/**
 * 一組相關的欄位（例如縣市／區域／地址、倉位／層）。
 *
 * 外面不再包一個 Field 加標題：裡面的標籤已經講完這是什麼，標題只是重複。拿掉標題之後
 * 這一組跟上面那排就黏在一起了（對話框內容區的 16px 對「一組」來說不夠），多給 8px 把它推開。
 */
export function FieldGroup({ children }: { children: ReactNode }) {
  return <div className="mt-2 grid gap-4">{children}</div>;
}

/** 對話框裡跟著目前選擇出現的補充說明（例如「這是星期六，設成平日之後…」）。 */
export function FieldNote({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-1 text-[12px] text-muted">{children}</p>;
}

/** 表單裡的唯讀值。長得像輸入框的位置，但明確不是輸入框。 */
export function StaticValue({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <p className="m-0 pt-2 text-[15px] font-bold text-ink">
      {children}
      {note ? <small className="mt-0.5 block text-[12px] font-normal text-muted">{note}</small> : null}
    </p>
  );
}
