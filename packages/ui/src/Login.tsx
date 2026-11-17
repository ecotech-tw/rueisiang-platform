import type { FormHTMLAttributes, ReactNode } from "react";

/**
 * 未登入頁（登入、設定密碼）的置中卡片：logo 與標題固定，下面放各頁自己的內容。
 * portal 與 HR app 的登入頁長得一樣，外觀只放這裡一份。
 */
export function LoginCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-[min(400px,100%)] rounded-2xl border border-line bg-paper px-8 py-9 text-center shadow-panel">
        <img className="h-auto w-[168px] object-contain" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={168} height={45} />
        <h1 className="mx-0 mt-2.5 mb-1.5 text-[22px]">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** 登入卡片裡的主要登入路（Google、LINE），是整頁跳轉的連結，不是 button。 */
export function LoginButton({ href, children }: { href: string; children: ReactNode }) {
  return <a className="mt-[22px] mb-3.5 block rounded-[10px] bg-brand px-4 py-[11px] font-bold text-white no-underline hover:bg-brand-dark" href={href}>{children}</a>;
}

export function LoginError({ children }: { children: ReactNode }) {
  return <p className="mx-0 mt-3.5 mb-0 rounded-[9px] bg-brand-soft px-3 py-[9px] text-[13px] text-brand-dark" role="alert">{children}</p>;
}

export function LoginNote({ children }: { children: ReactNode }) {
  return <p className="mx-0 mt-1.5 mb-0 text-[12px] text-muted">{children}</p>;
}

/**
 * 兩條登入路之間的分隔線。中間的字用卡片底色蓋掉線，不用額外的容器——
 * 沒有這條線的話，下面的表單看起來會像 Google 按鈕的附屬欄位。
 */
export function LoginDivider({ children }: { children: ReactNode }) {
  return (
    <div className="relative mt-5 w-full text-center before:absolute before:inset-x-0 before:top-1/2 before:border-t before:border-t-soft-line">
      <span className="relative bg-paper px-2.5 text-[12px] text-muted">{children}</span>
    </div>
  );
}

/** 卡片本身是置中的窄欄，表單要撐滿寬度並改回靠左，欄位沿用一般的 Field。 */
export function LoginForm(props: Omit<FormHTMLAttributes<HTMLFormElement>, "className">) {
  return <form className="mt-4 grid w-full gap-3.5 text-left" {...props} />;
}
