import type { FormEventHandler, FormHTMLAttributes, ReactNode } from "react";

interface FilterToolbarProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className" | "onSubmit"> {
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  className?: string;
}

/** 保留 form 語意，統一 HRIS 搜尋／篩選列的 class 與預設 submit 行為。 */
export function FilterToolbar({ children, onSubmit, className = "", ...props }: FilterToolbarProps) {
  return (
    <form
      {...props}
      className={`admin-form toolbar ${className}`.trim()}
      onSubmit={onSubmit ?? ((event) => event.preventDefault())}
    >
      {children}
    </form>
  );
}
