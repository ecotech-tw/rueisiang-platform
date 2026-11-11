import { useNavigate } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, EmptyRecords, Page, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrNotification, type HrNotificationsResponse } from "./api.js";
import { notificationTarget } from "./notification-link.js";

function formatTaipei(value: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function notificationTone(notification: HrNotification) {
  return notification.kind === "request_reviewed" ? (notification.title.includes("駁回") ? "danger" : "success") : notification.kind === "request_submitted" ? "info" : "neutral";
}

export function HrNotifications() {
  usePageTitle("通知");
  const navigate = useNavigate();
  const query = useHrQuery<HrNotificationsResponse>("/me/notifications");
  const write = useHrWrite();

  function open(notification: HrNotification) {
    if (!notification.readAt) write.mutate({ path: `/me/notifications/${notification.id}/read`, method: "POST", values: {} });
    // 取消通知是送給審核者；申請已離開待審清單，直接留在通知內避免連到空列表。
    if (notification.kind === "request_cancelled") return;
    navigate(notificationTarget(notification));
  }

  return <Page className="mx-auto w-full max-w-[760px] max-[760px]:max-w-none">
    <PageHeader title="通知" description="申請送出、審核結果與取消異動會在這裡保留。" className="max-[760px]:items-start" actions={query.data?.unreadCount ? <Button variant="secondary" disabled={write.isPending} onClick={() => write.mutate({ path: "/me/notifications/read-all", method: "POST", values: {} })}>全部標為已讀</Button> : null} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel className="min-h-0">
      {query.isPending ? <p className="muted">載入通知…</p> : query.data?.notifications.length ? <div className="grid gap-2">{query.data.notifications.map((notification) => <button type="button" className={`grid w-full cursor-pointer grid-cols-[38px_minmax(0,1fr)] items-start gap-2.5 rounded-[13px] border p-3 text-left text-ink ${ notification.readAt ? "border-line bg-paper hover:border-brand hover:bg-brand/5" : "border-brand/35 bg-brand-soft" }`} key={notification.id} onClick={() => open(notification)}>
        <span className="grid size-[38px] place-items-center rounded-xl bg-canvas text-brand-dark [&_svg]:size-5"><Icon name="notifications" /></span>
        <span className="grid min-w-0 gap-1 text-[13px] leading-normal"><span className="flex items-center justify-between gap-2"><strong className="min-w-0 text-[14px]">{notification.title}</strong>{notification.readAt ? <StatusBadge tone="neutral">已讀</StatusBadge> : <StatusBadge tone={notificationTone(notification)}>未讀</StatusBadge>}</span><span className="whitespace-pre-line text-muted wrap-anywhere">{notification.body}</span><small className="text-[11px] text-muted">{formatTaipei(notification.createdAt)}</small></span>
      </button>)}</div> : <EmptyRecords title="目前沒有通知" hint="新的申請處理結果會顯示在這裡。" />}
    </Panel>
  </Page>;
}
