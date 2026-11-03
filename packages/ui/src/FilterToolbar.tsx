import type { FormEventHandler, FormHTMLAttributes, ReactNode } from "react";

interface FilterToolbarProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className" | "onSubmit"> {
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  className?: string;
}

/**
 * 面板頂端的搜尋／篩選列，保留 form 語意與預設 submit 行為。
 * 負的左右外距抵掉 Panel 的內距，下緣分隔線才會貼齊面板兩側，跟表頭分成兩個區塊。
 * 裡面放的是有標題的 Field 時改成底部對齊，標題多出來的高度才不會把控制項推歪。
 */
export function FilterToolbar({ children, onSubmit, className = "", ...props }: FilterToolbarProps) {
  return (
    <form
      {...props}
      className={`-mx-[22px] -mt-1 flex flex-none flex-wrap items-center gap-2.5 border-b border-line px-[22px] pt-1 pb-[18px] has-[>[data-field]]:items-end max-[760px]:gap-2 ${className}`.trim()}
      onSubmit={onSubmit ?? ((event) => event.preventDefault())}
    >
      {children}
    </form>
  );
}
