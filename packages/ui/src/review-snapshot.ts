/**
 * 審核對話框拿的是「開啟當下」那一筆申請的快照；這裡判斷它跟最新的清單比起來還算不算數。
 *
 * 對話框不自動換成最新內容：自動換會在審核者打字到一半時清掉他打的東西，
 * 狀態變了還會讓同一個對話框無聲變成另一種操作（待審的審核框變成「取消已核准」）。
 * 所以內容過期時只鎖住操作並講明原因，由審核者自己按下載入。
 */
export type ReviewSnapshotState = "current" | "changed" | "gone";

interface ReviewSnapshot {
  status: string;
  revision?: number | null;
}

export function reviewSnapshotState(opened: ReviewSnapshot, latest: ReviewSnapshot | undefined): ReviewSnapshotState {
  // 不在清單裡、或狀態已經不同：這筆被處理掉或取消了。不提供載入——狀態不同的申請該用的是另一種對話框。
  if (!latest || latest.status !== opened.status) return "gone";
  return (latest.revision ?? null) === (opened.revision ?? null) ? "current" : "changed";
}

export const REVIEW_SNAPSHOT_NOTICE: Record<Exclude<ReviewSnapshotState, "current">, string> = {
  changed: "申請人在你開啟之後修改了這筆申請。請先載入最新內容，確認後再處理。",
  gone: "這筆申請已經被處理或取消，不在待處理的清單裡了。請關閉這個視窗。",
};
