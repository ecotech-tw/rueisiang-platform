import { REVIEW_SNAPSHOT_NOTICE, reviewSnapshotState } from "@rueisiang/ui";
import { describe, expect, it } from "vitest";

describe("審核對話框的快照還算不算數", () => {
  const opened = { status: "pending", revision: 1 };

  it("最新清單裡同一筆、同一版：可以處理", () => {
    expect(reviewSnapshotState(opened, { status: "pending", revision: 1 })).toBe("current");
  });

  it("申請人改過（版本不同）：鎖住，請審核者自己載入最新內容", () => {
    expect(reviewSnapshotState(opened, { status: "pending", revision: 2 })).toBe("changed");
    expect(REVIEW_SNAPSHOT_NOTICE.changed).toContain("載入最新內容");
  });

  it("已經不在清單裡：被處理掉或取消了", () => {
    expect(reviewSnapshotState(opened, undefined)).toBe("gone");
  });

  it("狀態變了就算版本一樣也不能繼續：待審的審核框不可以無聲變成「取消已核准」框", () => {
    expect(reviewSnapshotState(opened, { status: "approved", revision: 1 })).toBe("gone");
    expect(reviewSnapshotState({ status: "approved", revision: 1 }, { status: "approved", revision: 1 })).toBe("current");
  });

  it("沒有版本的申請（補打卡）只看狀態", () => {
    expect(reviewSnapshotState({ status: "pending" }, { status: "pending", revision: null })).toBe("current");
    expect(reviewSnapshotState({ status: "pending" }, { status: "approved" })).toBe("gone");
  });
});
