import type { HrNotification } from "./api.js";

type NotificationLink = Pick<HrNotification, "kind" | "entityKind" | "entityScope" | "entityId">;

/**
 * 通知要帶使用者去哪裡。ID 與批次鍵都不是使用者看得懂的東西，不塞進搜尋框；
 * 用專用參數讓清單直接只列通知提到的申請。
 *
 * - `review`／`reviewBatch`：審核者看待審清單裡的那一筆／那一批。
 * - `focus`／`batch`：申請人看自己紀錄裡的那一筆／那一批。
 */
export function notificationTarget(notification: NotificationLink) {
  const tab = notification.entityKind === "leave" ? "leave" : notification.entityKind === "overtime" ? "overtime" : "clock_correction";
  const batch = notification.entityScope === "batch";
  const params = notification.kind === "request_submitted"
    ? new URLSearchParams({ tab, [batch ? "reviewBatch" : "review"]: notification.entityId })
    : new URLSearchParams({ tab, status: "all", [batch ? "batch" : "focus"]: notification.entityId });
  return `/forms?${params.toString()}`;
}

/**
 * 申請紀錄是空的時候要說什麼。通知提到的申請「真的不在了」與「還在、只是被搜尋或狀態篩掉」
 * 是兩件事：混在一起的話，使用者改一下狀態篩選就會被告知申請可能已被取消。
 */
export function emptyRecordsMessage(input: { target: "request" | "batch" | null; targetExists: boolean; narrowed: boolean }) {
  if (input.target && !input.targetExists) {
    return input.target === "batch"
      ? { title: "這批加班申請已經不在紀錄裡", hint: "它們可能已被取消。點上方「改看全部」回到完整清單。" }
      : { title: "這筆申請已經不在紀錄裡", hint: "它可能已被取消。點上方「改看全部」回到完整清單。" };
  }
  if (input.narrowed) return { title: "找不到符合條件的申請", hint: "請調整搜尋文字或狀態篩選。" };
  return { title: "目前沒有申請紀錄", hint: "點＋開始新增申請。" };
}
