import type { ReactNode } from "react";

/** 按鈕與結果訊息排成一列；成功提示與錯誤 Alert 太長時換到下一行。 */
export const ASSISTANT_ACTIONS = "mt-2.5 flex flex-wrap items-center gap-2";

/** Sandbox 設定欄裡的一段：上緣分隔線、標題與說明，右側可放狀態或按鈕。 */
export function AssistantSubsection({ title, description, aside, children }: {
  title: ReactNode;
  description: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-3.5 border-t border-t-soft-line pt-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="mx-0 mt-0 mb-1 text-[14px]">{title}</h3>
          <p className="muted">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}
