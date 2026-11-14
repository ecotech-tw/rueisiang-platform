import type { ReactNode } from "react";

export { Field, FieldHint, Input, InputSkin, SelectField, Textarea, TextField } from "@rueisiang/ui";

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
