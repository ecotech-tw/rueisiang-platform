import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import type { SessionUser } from "../auth/session.js";
import { Icon } from "./icons.js";
import { useGuardedAction, useGuardedClick } from "./UnsavedChanges.js";

/** 平台 sidebar 與 HRIS 右上角共用同一顆頭像，Google 頭像的載入規則只寫一次。 */
export function UserAvatar({ user }: { user: SessionUser }) {
  const initial = (user.name || user.email || "R").trim().charAt(0).toUpperCase();
  return (
    <span className="account-avatar">
      {user.pictureUrl ? (
        // Google 的頭像網址會擋帶 referrer 的請求，舊系統兩套都踩過這個坑。
        <img className="account-avatar-image" src={user.pictureUrl} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="account-avatar-initial" aria-hidden="true">{initial}</span>
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
  onLogout: () => void;
  onNavigate: () => void;
}

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
export function AccountPanel({ user, onLogout, onNavigate }: AccountPanelProps) {
  const [open, setOpen] = useState(false);
  const guardedClick = useGuardedClick();
  const guardedAction = useGuardedAction();
  const panelRef = useRef<HTMLDivElement>(null);

  useDismiss(panelRef, open, () => setOpen(false));

  if (!user) return null;

  const displayName = user.name || user.email;

  return (
    <div className="account-panel" ref={panelRef}>
      <button
        type="button"
        className="account-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        title={user.email}
      >
        <UserAvatar user={user} />
        <span className="account-copy">
          <strong>{displayName}</strong>
          <small>{user.email}</small>
        </span>
        <span className="account-chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-menu-profile">
            <strong>{displayName}</strong>
            <small>{user.email}</small>
            <div className="account-roles">
              {user.roles.length === 0 ? (
                <span className="account-role">沒有任何角色</span>
              ) : (
                user.roles.map((role) => (
                  <span className="account-role" key={role}>{ROLE_LABEL[role] ?? role}</span>
                ))
              )}
            </div>
          </div>

          <Link
            className="account-menu-item"
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
              className="account-menu-item"
              role="menuitem"
              href={`${HR_APP_URL}/profile`}
              onClick={() => {
                setOpen(false);
                onNavigate();
              }}
            >
              <Icon name="people" className="account-menu-icon" />
              我的人事資料
            </a>
          ) : null}

          {!user.isEmployee && user.permissions.includes("hr:request:review") ? (
            <Link
              className="account-menu-item"
              role="menuitem"
              to="/hr/requests"
              onClick={(event) => guardedClick(event, "/hr/requests", () => {
                setOpen(false);
                onNavigate();
              })}
            >
              <Icon name="edit" className="account-menu-icon" />
              申請與審核
            </Link>
          ) : null}

          {/* 登出要在打 API 之前問；等 beforeunload 跳出來時 session 已經被砍掉了。 */}
          <button type="button" className="account-menu-item danger" role="menuitem" onClick={() => { void guardedAction(onLogout); }}>
            <span aria-hidden="true">↪</span>
            登出
          </button>
        </div>
      ) : null}
    </div>
  );
}
