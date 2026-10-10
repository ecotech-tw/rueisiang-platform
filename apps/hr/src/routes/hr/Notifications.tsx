import { useNavigate } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrNotification, type HrNotificationsResponse } from "./api.js";

function formatTaipei(value: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function notificationTone(notification: HrNotification) {
  return notification.kind === "request_reviewed" ? (notification.title.includes("駁回") ? "danger" : "success") : notification.kind === "request_submitted" ? "info" : "neutral";
}

function notificationTarget(notification: HrNotification) {
  const tab = notification.entityKind === "leave" ? "leave" : notification.entityKind === "overtime" ? "overtime" : "clock_correction";
  const batch = notification.entityScope === "batch";
  const params = notification.kind === "request_submitted"
    ? new URLSearchParams({ tab, [batch ? "reviewBatch" : "review"]: notification.entityId })
    // ID 與批次鍵都不是使用者看得懂的東西，不塞進搜尋框；清單直接只列通知提到的申請。
    : new URLSearchParams({ tab, status: "all", [batch ? "batch" : "focus"]: notification.entityId });
  return `/forms?${params.toString()}`;
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

  return <div className="page hr-notifications-page">
    <PageHeader title="通知" description="申請送出、審核結果與取消異動會在這裡保留。" actions={query.data?.unreadCount ? <Button variant="secondary" disabled={write.isPending} onClick={() => write.mutate({ path: "/me/notifications/read-all", method: "POST", values: {} })}>全部標為已讀</Button> : null} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel className="hr-notification-panel">
      {query.isPending ? <p className="muted">載入通知…</p> : query.data?.notifications.length ? <div className="hr-notification-list">{query.data.notifications.map((notification) => <button type="button" className={`hr-notification-item${notification.readAt ? " read" : " unread"}`} key={notification.id} onClick={() => open(notification)}>
        <span className="hr-notification-icon"><Icon name="notifications" /></span>
        <span className="hr-notification-copy"><span className="hr-notification-title"><strong>{notification.title}</strong>{notification.readAt ? <StatusBadge tone="neutral">已讀</StatusBadge> : <StatusBadge tone={notificationTone(notification)}>未讀</StatusBadge>}</span><span>{notification.body}</span><small>{formatTaipei(notification.createdAt)}</small></span>
      </button>)}</div> : <div className="hr-form-empty-state"><strong>目前沒有通知</strong><p className="muted">新的申請處理結果會顯示在這裡。</p></div>}
    </Panel>
  </div>;
}
