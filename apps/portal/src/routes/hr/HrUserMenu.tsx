import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { logout, useSession } from "../../auth/session.js";
import { UserAvatar, useDismiss } from "../../shell/AccountPanel.js";
import { navigateAcrossHr } from "../../shell/hr-transition.js";
import { useGuardedAction, useGuardedClick } from "../../shell/UnsavedChanges.js";
import { Icon } from "../../shell/icons.js";

/**
 * HRIS 右上角的帳號選單。HRIS 不借用平台 sidebar，所以「回平台」與「登出」收在頭像底下，
 * 不再各佔一顆常駐按鈕。
 *
 * 選單關著時仍留在 DOM、用 inert 擋掉焦點與點擊：開關才能用 transition 收放，
 * 快速連點時會從當下的位置反向，不會重播。
 */
export function HrUserMenu() {
  const { user } = useSession();
  const navigate = useNavigate();
  const guardedClick = useGuardedClick();
  const guardedAction = useGuardedAction();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  useDismiss(rootRef, open, (event) => {
    setOpen(false);
    if (event instanceof KeyboardEvent) triggerRef.current?.focus();
  });

  // 鍵盤打開選單時焦點直接落在第一項；滑鼠點開時瀏覽器不會替程式設定的焦點畫外框。
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  if (!user) return null;
  const displayName = user.name || user.email;

  return (
    <div className={`hr-user-menu${open ? " open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="hr-user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="hr-user-dropdown"
        aria-label={`帳號選單：${displayName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar user={user} />
      </button>

      <div id="hr-user-dropdown" className="hr-user-dropdown" role="menu" aria-label="帳號選單" inert={!open}>
        <div className="hr-user-profile">
          <strong>{displayName}</strong>
          <small>{user.email}</small>
        </div>
        <Link
          ref={firstItemRef}
          to="/"
          role="menuitem"
          className="hr-system-submenu-link"
          onClick={(event) => guardedClick(event, "/", () => {
            setOpen(false);
            navigateAcrossHr(event, navigate, "/");
          })}
        >
          <Icon name="apps" />
          <span>Ruei Siang 平台</span>
        </Link>
        <button type="button" role="menuitem" className="hr-system-submenu-link danger" onClick={() => { void guardedAction(() => logout()); }}>
          <Icon name="logout" />
          <span>登出</span>
        </button>
      </div>
    </div>
  );
}
