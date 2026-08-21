/**
 * 選單圖示。
 *
 * 手繪的 24×24 線性圖示，形狀比照 Material Symbols 的 outlined 風格：
 * 統一 1.8 的線寬、圓端點、只用 currentColor，所以顏色跟著文字走。
 *
 * 為什麼不直接載 Material Symbols 字型：那是一個外部相依（字型檔或 CDN），
 * 而我們只用得到十幾個圖示。內嵌 SVG 沒有額外請求、沒有 FOUT，
 * 也不必為了 CSP 再開一個來源。
 */

export type IconName =
  | "people"
  | "list"
  | "personAdd"
  | "tag"
  | "history"
  | "sync"
  | "warehouse"
  | "grid"
  | "box"
  | "cloudSync"
  | "category"
  | "widgets"
  | "payments"
  | "storefront"
  | "assistant"
  | "science"
  | "line"
  | "webhook"
  | "analytics"
  | "tune"
  | "chat"
  | "shieldPerson"
  | "key"
  | "filter"
  | "info"
  | "edit"
  | "eye"
  | "copy"
  | "block"
  | "unblock"
  | "trash"
  | "close"
  | "bookmark"
  | "check"
  | "calendar"
  | "plus"
  | "search"
  | "chevronUp"
  | "chevronDown"
  | "pageFirst"
  | "pageLast"
  | "chevronLeft"
  | "chevronRight"
  | "external";

const PATHS: Record<IconName, React.ReactNode> = {
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </>
  ),
  /* 到第一頁／最後一頁：一個箭頭加一條擋牆。 */
  pageFirst: (
    <>
      <path d="M17 18.5 10.5 12 17 5.5" />
      <path d="M7 5.5v13" />
    </>
  ),
  pageLast: (
    <>
      <path d="M7 5.5 13.5 12 7 18.5" />
      <path d="M17 5.5v13" />
    </>
  ),
  chevronUp: <path d="M6.5 14.5 12 9l5.5 5.5" />,
  chevronDown: <path d="M6.5 9.5 12 15l5.5-5.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.9" />
    </>
  ),
  /* 漏斗。Material 的 filter_alt，簡化成三條線。 */
  filter: (
    <>
      <path d="M4 5.5h16" />
      <path d="M7.5 12h9" />
      <path d="M10.5 18.5h3" />
    </>
  ),
  /* 角色＝一串權限的組合，鑰匙比盾牌更貼切；盾牌留給「帳號與權限」那一頁。 */
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9" />
      <path d="M17.5 12v3.2" />
      <path d="M20.4 12v2.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14" />
    </>
  ),
  people: (
    <>
      <circle cx="9.2" cy="8.6" r="3.3" />
      <path d="M3.4 19.2c0-3.1 2.6-4.9 5.8-4.9s5.8 1.8 5.8 4.9" />
      <path d="M16.4 5.9a3.3 3.3 0 0 1 0 5.6" />
      <path d="M17.6 14.7c1.9.6 3 2 3 4.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.8h11.2M9 12h11.2M9 17.2h11.2" />
      <circle cx="4.6" cy="6.8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="17.2" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  personAdd: (
    <>
      <circle cx="10" cy="8.4" r="3.3" />
      <path d="M3.8 19.2c0-3.1 2.8-4.9 6.2-4.9.9 0 1.7.12 2.5.37" />
      <path d="M17.6 13.8v6.2M14.5 16.9h6.2" />
    </>
  ),
  tag: (
    <>
      <path d="M4.2 6.6A2.4 2.4 0 0 1 6.6 4.2h5.1c.6 0 1.2.25 1.7.7l6 6a2.4 2.4 0 0 1 0 3.4l-4.9 4.9a2.4 2.4 0 0 1-3.4 0l-6-6a2.4 2.4 0 0 1-.9-1.7z" />
      <circle cx="8.5" cy="8.5" r="1.5" />
    </>
  ),
  history: (
    <>
      <path d="M4.3 12a7.7 7.7 0 1 0 2.5-5.7" />
      <path d="M4.1 4.4v4h4" />
      <path d="M12 7.9V12l2.9 1.7" />
    </>
  ),
  sync: (
    <>
      <path d="M4.6 12a7.4 7.4 0 0 1 12.2-5.6" />
      <path d="M17.4 3.4v3.5h-3.5" />
      <path d="M19.4 12a7.4 7.4 0 0 1-12.2 5.6" />
      <path d="M6.6 20.6v-3.5h3.5" />
    </>
  ),
  warehouse: (
    <>
      <path d="M3.6 9.9 12 4.7l8.4 5.2v9.9H3.6z" />
      <path d="M8.6 19.8v-6.1h6.8v6.1" />
      <path d="M8.6 16.7h6.8" />
    </>
  ),
  grid: (
    <>
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2.2" />
      <path d="M9.9 4.4v15.2M3.6 12h16.8" />
    </>
  ),
  box: (
    <>
      <path d="M3.9 8.2 12 4.1l8.1 4.1v7.6L12 19.9l-8.1-4.1z" />
      <path d="m3.9 8.2 8.1 4.1 8.1-4.1M12 12.3v7.6" />
    </>
  ),
  cloudSync: (
    <>
      <path d="M7.6 16.4a3.7 3.7 0 0 1 .3-7.4 5 5 0 0 1 9.4-.3 3.5 3.5 0 0 1 .9 6.9" />
      <path d="M9.9 18.6a2.9 2.9 0 0 0 4.9 1.2" />
      <path d="M9.6 21v-2.4H12" />
    </>
  ),
  category: (
    <>
      <path d="M12 3.7 16.5 10.4h-9z" />
      <rect x="4" y="13.2" width="6.8" height="6.8" rx="1.5" />
      <circle cx="17" cy="16.6" r="3.4" />
    </>
  ),
  widgets: (
    <>
      <rect x="3.9" y="3.9" width="6.8" height="6.8" rx="1.6" />
      <rect x="13.3" y="3.9" width="6.8" height="6.8" rx="1.6" />
      <rect x="3.9" y="13.3" width="6.8" height="6.8" rx="1.6" />
      <rect x="13.3" y="13.3" width="6.8" height="6.8" rx="1.6" />
    </>
  ),
  payments: (
    <>
      <rect x="2.9" y="5.9" width="18.2" height="12.2" rx="2.2" />
      <circle cx="12" cy="12" r="2.7" />
      <path d="M6.4 9.4v5.2M17.6 9.4v5.2" />
    </>
  ),
  storefront: (
    <>
      <path d="M4.3 9.8h15.4v9.1a1 1 0 0 1-1 1H5.3a1 1 0 0 1-1-1z" />
      <path d="M3.2 9.8 4.7 5.1a1 1 0 0 1 1-.7h12.6a1 1 0 0 1 1 .7l1.5 4.7" />
      <path d="M9.7 19.9v-4.8h4.6v4.8" />
    </>
  ),
  assistant: (
    <>
      <path d="M12 3.8 13.8 9l5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2L5 10.8 10.2 9z" />
      <path d="m18.1 15.3.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8z" />
    </>
  ),
  science: (
    <>
      <path d="M9 3.8h6M10.2 3.8v5.1l-5.1 8.2a2 2 0 0 0 1.7 3.1h10.4a2 2 0 0 0 1.7-3.1l-5.1-8.2V3.8" />
      <path d="M7.2 15.3h9.6" />
    </>
  ),
  line: (
    <>
      <path d="M20.6 10.8c0 4.2-3.8 7.7-8.6 7.7-1 0-2-.1-2.9-.4L5 20.4l.8-3.1c-1.3-1.4-2-3.1-2-5.1 0-4.2 3.8-7.7 8.6-7.7s8.2 2.8 8.2 6.3Z" />
      <path d="M8 10.2v3.7h2.2M12.2 10.2v3.7M15.2 10.2v3.7h2.2" />
    </>
  ),
  webhook: (
    <>
      <circle cx="6.2" cy="12" r="2.2" />
      <circle cx="17.8" cy="6.5" r="2.2" />
      <circle cx="17.8" cy="17.5" r="2.2" />
      <path d="m8.2 11 7.5-3.6M8.2 13l7.5 3.6" />
    </>
  ),
  analytics: (
    <>
      <path d="M4.5 19.5V13M10 19.5V8.5M15.5 19.5V4.5M21 19.5V10" />
    </>
  ),
  tune: (
    <>
      <path d="M3.8 7.6h9.4M18.1 7.6h2.1" />
      <path d="M3.8 16.4h2.1M10.8 16.4h9.4" />
      <circle cx="15.6" cy="7.6" r="2.4" />
      <circle cx="8.4" cy="16.4" r="2.4" />
    </>
  ),
  chat: (
    <>
      <path d="M4.4 5.2h15.2a1.8 1.8 0 0 1 1.8 1.8v8.2a1.8 1.8 0 0 1-1.8 1.8H11l-4.8 3v-3H4.4a1.8 1.8 0 0 1-1.8-1.8V7a1.8 1.8 0 0 1 1.8-1.8Z" />
      <path d="M7.7 10.9h8.6M7.7 14.1h5.2" />
    </>
  ),
  edit: (
    <>
      <path d="M4.4 16.2V19.6h3.4L19 8.4l-3.4-3.4z" />
      <path d="m14.4 5.8 3.4 3.4" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="m6.2 6.2 11.6 11.6" />
    </>
  ),
  unblock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="m8.3 12.2 2.6 2.6 4.8-5.2" />
    </>
  ),
  trash: (
    <>
      <path d="M4.6 6.6h14.8" />
      <path d="M9.4 6.6V4.9a.9.9 0 0 1 .9-.9h3.4a.9.9 0 0 1 .9.9v1.7" />
      <path d="m6.6 6.6.9 12.4a1.4 1.4 0 0 0 1.4 1.3h6.2a1.4 1.4 0 0 0 1.4-1.3l.9-12.4" />
      <path d="M10.4 10.4v6M13.6 10.4v6" />
    </>
  ),
  close: <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" />,
  bookmark: <path d="M7 4.2h10a.8.8 0 0 1 .8.8v14.4L12 16.1l-5.8 3.3V5a.8.8 0 0 1 .8-.8z" />,
  check: <path d="M5.2 12.6 9.8 17.2 18.8 7.4" />,
  calendar: (
    <>
      <rect x="3.6" y="5.2" width="16.8" height="15.2" rx="2.4" />
      <path d="M3.6 9.8h16.8M8.4 3.6v3.2M15.6 3.6v3.2" />
    </>
  ),
  chevronLeft: <path d="M14.6 5.6 8.2 12l6.4 6.4" />,
  chevronRight: <path d="M9.4 5.6 15.8 12l-6.4 6.4" />,
  external: (
    <>
      <path d="M13.4 4.6h6v6" />
      <path d="M19.4 4.6 11 13" />
      <path d="M18.2 14.2v4.4a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V7.6a1.8 1.8 0 0 1 1.8-1.8h4.4" />
    </>
  ),
  shieldPerson: (
    <>
      <path d="M12 3.5 19 5.9v5.9c0 4-2.8 6.9-7 8.2-4.2-1.3-7-4.2-7-8.2V5.9z" />
      <circle cx="12" cy="10.1" r="1.9" />
      <path d="M8.8 15.4c.5-1.4 1.8-2.2 3.2-2.2s2.7.8 3.2 2.2" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
