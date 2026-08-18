import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { SessionUser } from "../auth/session.js";

interface AccountPanelProps {
  user: SessionUser | null;
  onLogout: () => void;
  onNavigate: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  admin: "管理者",
  manager: "主管",
  staff: "一般同仁",
  viewer: "檢視者",
};

const SCOPE_LABEL: Record<string, string> = {
  store: "店別",
  warehouse: "倉庫",
};

function roleText(role: { role: string; scopeType: string; scopeId: string }): string {
  const name = ROLE_LABEL[role.role] ?? role.role;
  if (!role.scopeType) return name;
  return `${name}（${SCOPE_LABEL[role.scopeType] ?? role.scopeType}：${role.scopeId}）`;
}

/**
 * Sidebar 左下角的帳號區。沿用 CRM 的作法：頭像＋姓名一列，點開才出現操作，
 * 而不是把「登出」這種一去不復返的動作直接裸露在選單上。
 *
 * 這裡只放跟「我自己」有關的東西。權限管理是管別人的，屬於系統管理那一段。
 */
export function AccountPanel({ user, onLogout, onNavigate }: AccountPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnOutside(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!user) return null;

  const displayName = user.name || user.email;
  const initial = (user.name || user.email || "R").trim().charAt(0).toUpperCase();

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
        <span className="account-avatar">
          {user.pictureUrl ? (
            // Google 的頭像網址會擋帶 referrer 的請求，舊系統兩套都踩過這個坑。
            <img className="account-avatar-image" src={user.pictureUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="account-avatar-initial" aria-hidden="true">{initial}</span>
          )}
        </span>
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
                  <span className="account-role" key={`${role.role}-${role.scopeType}-${role.scopeId}`}>
                    {roleText(role)}
                  </span>
                ))
              )}
            </div>
          </div>

          <Link
            className="account-menu-item"
            role="menuitem"
            to="/me"
            onClick={() => {
              setOpen(false);
              onNavigate();
            }}
          >
            <span aria-hidden="true">☺</span>
            個人資料
          </Link>

          <button type="button" className="account-menu-item danger" role="menuitem" onClick={onLogout}>
            <span aria-hidden="true">↪</span>
            登出
          </button>
        </div>
      ) : null}
    </div>
  );
}
