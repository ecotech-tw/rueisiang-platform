import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import type { SessionUser } from "../auth/session.js";
import { Icon } from "./icons.js";
import { useGuardedAction, useGuardedClick } from "./UnsavedChanges.js";

const AVATAR_VARIANT = {
  // sidebar 的帳號列是白底卡片，頭像要一圈白邊加落影才浮得起來。
  sidebar: "size-[38px] border-2 border-white [box-shadow:0_0_0_1px_var(--color-line),0_5px_12px_rgba(173,40,44,.16)]",
  // HRIS 的頭像放在玻璃按鈕裡，落影會跟玻璃的光澤打架，只留一道髮絲外框。
  glass: "size-9 outline-1 -outline-offset-1 outline-ink/10",
};

/** 平台 sidebar 與 HRIS 右上角共用同一顆頭像，Google 頭像的載入規則只寫一次。 */
export function UserAvatar({ user, variant = "sidebar" }: { user: Pick<SessionUser, "name" | "email" | "pictureUrl">; variant?: keyof typeof AVATAR_VARIANT }) {
  const initial = (user.name || user.email || "R").trim().charAt(0).toUpperCase();
  return (
    <span className={`grid place-items-center overflow-hidden rounded-[50%] text-white [background:linear-gradient(145deg,var(--color-brand),#e86a63)] ${AVATAR_VARIANT[variant]}`}>
      {user.pictureUrl ? (
        // Google 的頭像網址會擋帶 referrer 的請求，舊系統兩套都踩過這個坑。
        <img className="block size-full object-cover" src={user.pictureUrl} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="text-[15px] font-extrabold" aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}

/** 帳號選單點外面或按 Escape 就收起；Escape 會傳進 onClose，讓呼叫端決定焦點要不要還給按鈕。 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: (event: PointerEvent | KeyboardEvent) => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    function closeOnOutside(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onCloseRef.current(event);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current(event);
    }

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, ref]);
}

interface AccountPanelProps {
  user: SessionUser | null;
  collapsed: boolean;
  onLogout: () => void;
  onNavigate: () => void;
}

const MENU_ITEM = "flex w-full items-center gap-[9px] border-0 bg-transparent px-3 py-[11px] text-left text-[13px] no-underline";
const MENU_ITEM_TONE = `${MENU_ITEM} text-ink hover:bg-soft-line`;
const MENU_ICON = "size-5 flex-none text-brand";
const ROLE = "rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-bold text-brand-dark";

const HR_APP_URL = (import.meta.env.VITE_HR_APP_URL?.trim() || (import.meta.env.DEV ? "http://localhost:5176" : "https://hr.rueisiang.com")).replace(/\/+$/, "");

const ROLE_LABEL: Record<string, string> = {
  admin: "管理者",
  manager: "主管",
  staff: "一般同仁",
  viewer: "檢視者",
};

/**
 * Sidebar 左下角的帳號區。沿用 CRM 的作法：頭像＋姓名一列，點開才出現操作，
 * 而不是把「登出」這種一去不復返的動作直接裸露在選單上。
 *
 * 這裡只放跟「我自己」有關的東西。權限管理是管別人的，屬於系統管理那一段。
 */
export function AccountPanel({ user, collapsed, onLogout, onNavigate }: AccountPanelProps) {
  const [open, setOpen] = useState(false);
  const guardedClick = useGuardedClick();
  const guardedAction = useGuardedAction();
  const panelRef = useRef<HTMLDivElement>(null);

  useDismiss(panelRef, open, () => setOpen(false));

  if (!user) return null;

  const displayName = user.name || user.email;

  return (
    <div className="relative mt-2.5 min-w-0" ref={panelRef}>
      <button
        type="button"
        className={`group/account grid w-full min-w-0 grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-[9px] rounded-card border border-line bg-white p-2 text-left text-ink hover:border-secondary hover:bg-[#fff9f8] aria-expanded:border-secondary aria-expanded:bg-[#fff9f8] ${collapsed ? "min-[901px]:flex min-[901px]:justify-center min-[901px]:gap-0 min-[901px]:p-1.5" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        title={user.email}
      >
        <UserAvatar user={user} />
        <span className={`grid min-w-0 ${collapsed ? "min-[901px]:hidden" : ""}`}>
          <strong className="truncate text-[12px]">{displayName}</strong>
          <small className="truncate text-[10px] text-muted">{user.email}</small>
        </span>
        <span
          className={`mr-[3px] size-2 border-r-2 border-b-2 border-muted [transform:rotate(45deg)] transition-[transform] duration-180 ease-out motion-reduce:transition-none group-aria-expanded/account:[transform:rotate(225deg)] ${collapsed ? "min-[901px]:hidden" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        // 收合成窄欄時選單改從頭像右邊長出來，不然 232px 的選單會被擠成 60px 寬。
        <div
          className={`absolute inset-x-0 bottom-[calc(100%+9px)] z-40 overflow-hidden rounded-card border border-line bg-white [box-shadow:0_16px_36px_rgba(64,30,30,.16)] ${collapsed ? "min-[901px]:right-auto min-[901px]:bottom-0 min-[901px]:left-[52px] min-[901px]:w-[232px]" : ""}`}
          role="menu"
        >
          <div className="grid gap-0.5 border-b border-soft-line p-3">
            <strong className="text-[13px]">{displayName}</strong>
            <small className="text-[11px] break-all text-muted">{user.email}</small>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {user.roles.length === 0 ? (
                <span className={ROLE}>沒有任何角色</span>
              ) : (
                user.roles.map((role) => (
                  <span className={ROLE} key={role}>{ROLE_LABEL[role] ?? role}</span>
                ))
              )}
            </div>
          </div>

          <Link
            className={MENU_ITEM_TONE}
            role="menuitem"
            to="/me"
            onClick={(event) => guardedClick(event, "/me", () => {
              setOpen(false);
              onNavigate();
            })}
          >
            <span aria-hidden="true">☺</span>
            個人資料
          </Link>

          {user.isEmployee ? (
            <a
              className={MENU_ITEM_TONE}
              role="menuitem"
              href={`${HR_APP_URL}/profile`}
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <Icon name="people" className={MENU_ICON} />
              我的人事資料
            </a>
          ) : null}

          {!user.isEmployee && user.permissions.includes("hr:request:review") ? (
            <Link
              className={MENU_ITEM_TONE}
              role="menuitem"
              to="/hr/requests"
              onClick={(event) => guardedClick(event, "/hr/requests", () => {
                setOpen(false);
                onNavigate();
              })}
            >
              <Icon name="edit" className={MENU_ICON} />
              申請與審核
            </Link>
          ) : null}

          {/* 登出要在打 API 之前問；等 beforeunload 跳出來時 session 已經被砍掉了。 */}
          <button type="button" className={`${MENU_ITEM} font-bold text-brand-dark hover:bg-brand-soft`} role="menuitem" onClick={() => { void guardedAction(onLogout); }}>
            <span aria-hidden="true">↪</span>
            登出
          </button>
        </div>
      ) : null}
    </div>
  );
}
