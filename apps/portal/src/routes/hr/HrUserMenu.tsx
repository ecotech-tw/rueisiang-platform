import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { logout, useSession } from "../../auth/session.js";
import { UserAvatar, useDismiss } from "../../shell/AccountPanel.js";
import { navigateAcrossHr } from "../../shell/hr-transition.js";
import { useGuardedAction, useGuardedClick } from "../../shell/UnsavedChanges.js";
import { Icon } from "../../shell/icons.js";
import { HR_USER_MENU, hrMenuItemClass, hrUserDropdownClass, hrUserTriggerClass } from "./HrShell.js";

/**
 * HRIS 右上角的帳號選單。HRIS 不借用平台 sidebar，所以「回平台」與「登出」收在頭像底下，
 * 不再各佔一顆常駐按鈕。
 *
 * 選單關著時仍留在 DOM、用 inert 擋掉焦點與點擊：開關才能用 transition 收放，
 * 快速連點時會從當下的位置反向，不會重播。
 */
export function HrUserMenu({ onOpen }: { onOpen?: () => void } = {}) {
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
    <div className={HR_USER_MENU} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={hrUserTriggerClass(open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="hr-user-dropdown"
        aria-label={`帳號選單：${displayName}`}
        onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}
      >
        <UserAvatar user={user} variant="glass" />
      </button>

      <div id="hr-user-dropdown" className={hrUserDropdownClass(open)} role="menu" aria-label="帳號選單" inert={!open}>
        <div className="mb-1 grid min-w-0 gap-0.5 border-b border-b-ink/8 px-3 pt-2 pb-2.5">
          <strong className="truncate text-[13px] text-ink">{displayName}</strong>
          <small className="truncate text-[12px] text-muted">{user.email}</small>
        </div>
        <Link
          ref={firstItemRef}
          to="/"
          role="menuitem"
          className={hrMenuItemClass({})}
          onClick={(event) => guardedClick(event, "/", () => {
            setOpen(false);
            navigateAcrossHr(event, navigate, "/");
          })}
        >
          <Icon name="apps" />
          <span>Ruei Siang 平台</span>
        </Link>
        <button type="button" role="menuitem" className={hrMenuItemClass({ danger: true, button: true })} onClick={() => { void guardedAction(() => logout()); }}>
          <Icon name="logout" />
          <span>登出</span>
        </button>
      </div>
    </div>
  );
}
