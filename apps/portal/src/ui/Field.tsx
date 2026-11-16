import type { ReactNode } from "react";
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
 * 一組相關的欄位（例如縣市／區域／地址、倉位／層）。
 *
 * 外面不再包一個 Field 加標題：裡面的標籤已經講完這是什麼，標題只是重複。拿掉標題之後
 * 這一組跟上面那排就黏在一起了（對話框內容區的 16px 對「一組」來說不夠），多給 8px 把它推開。
 */
export function FieldGroup({ children }: { children: ReactNode }) {
  return <div className="mt-2 grid gap-4">{children}</div>;
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
