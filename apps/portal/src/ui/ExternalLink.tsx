import type { ReactNode } from "react";

/**
 * 開新分頁的連結。箭頭圖示由呼叫端放進 children（<Icon name="external" />），
 * 先講清楚會離開這一頁，不用等 hover。
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="inline-flex items-center gap-[5px] text-brand-dark no-underline hover:underline [&_svg]:size-3.5 [&_svg]:opacity-65"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
