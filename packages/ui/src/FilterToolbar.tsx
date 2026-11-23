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
 * 手機上在列表面板（Panel grows）裡時，整頁捲，這一列黏在捲動區頂端，往下翻很多筆也隨時能改條件；背景帶撐到畫面兩側（--bleed，
 * 列表面板在手機上拿掉外框時等於頁面留邊），底下捲過去的卡片才不會從兩側露出來。
 * 一般面板裡（表單式的篩選、報表頁）不黏也不換底色：面板本身有底色，換成頁面底色會多出一條色帶。
 */
export function FilterToolbar({ children, onSubmit, className = "", ...props }: FilterToolbarProps) {
  return (
    <form
      {...props}
      className={`-mx-[22px] -mt-1 flex flex-none flex-wrap items-center gap-2.5 border-b border-line px-[22px] pt-1 pb-[18px] has-[>[data-field]]:items-end max-[760px]:gap-2 max-[760px]:[[data-grows]_&]:sticky max-[760px]:[[data-grows]_&]:top-[calc(var(--page-pad-top,0px)*-1)] max-[760px]:[[data-grows]_&]:z-4 max-[760px]:[[data-grows]_&]:mx-[calc(var(--bleed,0px)*-1)] max-[760px]:[[data-grows]_&]:mt-0 max-[760px]:[[data-grows]_&]:bg-canvas/90 max-[760px]:[[data-grows]_&]:px-[var(--bleed,0px)] max-[760px]:[[data-grows]_&]:pt-3 max-[760px]:[[data-grows]_&]:pb-3 max-[760px]:[[data-grows]_&]:[-webkit-backdrop-filter:blur(12px)] max-[760px]:[[data-grows]_&]:[backdrop-filter:blur(12px)] ${className}`.trim()}
      onSubmit={onSubmit ?? ((event) => event.preventDefault())}
    >
      {children}
    </form>
  );
}
