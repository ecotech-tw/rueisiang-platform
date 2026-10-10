// @vitest-environment jsdom
import { useOvertimeBatchSelection } from "@rueisiang/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

type Day = { date: string; startAt: string | null; hasExisting: boolean };
type Selection = ReturnType<typeof useOvertimeBatchSelection>;

let root: Root | null = null;
let latest: Selection;

function Probe({ days, minutes }: { days: Day[]; minutes: number | null }) {
  latest = useOvertimeBatchSelection(days, minutes);
  return null;
}

async function render(days: Day[], minutes: number | null) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe days={days} minutes={minutes} />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

const scheduled = (date: string, hasExisting = false): Day => ({ date, startAt: `${date}T18:00`, hasExisting });

describe("多日加班的選擇狀態", () => {
  it("不同時數點不同天，各自成為一筆；同時數再點一次取消", async () => {
    const days = [scheduled("2026-09-03"), scheduled("2026-09-04"), scheduled("2026-09-10")];
    await render(days, 60);
    await act(async () => { latest.toggleDay("2026-09-03"); latest.toggleDay("2026-09-04"); });
    await render(days, 120);
    await act(async () => { latest.toggleDay("2026-09-10"); });

    expect(latest.summary).toMatchObject({ days: 3, totalMinutes: 240 });
    expect(latest.entries).toEqual([
      { requestedStart: "2026-09-03T18:00", requestedEnd: "2026-09-03T19:00" },
      { requestedStart: "2026-09-04T18:00", requestedEnd: "2026-09-04T19:00" },
      { requestedStart: "2026-09-10T18:00", requestedEnd: "2026-09-10T20:00" },
    ]);
    expect(latest.complete).toBe(true);

    await act(async () => { latest.toggleDay("2026-09-10"); });
    expect(latest.summary.days).toBe(2);
    // 換一個時數點已選的日子是改時數，不是取消。
    await act(async () => { latest.toggleDay("2026-09-03"); });
    expect(latest.assigned["2026-09-03"]).toBe(120);
  });

  it("時數不合法時點日期沒有作用", async () => {
    const days = [scheduled("2026-09-03")];
    await render(days, 20);
    await act(async () => { latest.toggleDay("2026-09-03"); });
    expect(latest.summary.days).toBe(0);
    expect(latest.complete).toBe(false);
  });

  it("重抓班表後變成已有申請的日子會移出送出內容並回報", async () => {
    await render([scheduled("2026-09-03"), scheduled("2026-09-04")], 60);
    await act(async () => { latest.toggleDay("2026-09-03"); latest.toggleDay("2026-09-04"); });
    expect(latest.entries).toHaveLength(2);

    await render([scheduled("2026-09-03"), scheduled("2026-09-04", true)], 60);
    expect(latest.takenDates).toEqual(["2026-09-04"]);
    expect(latest.entries).toEqual([{ requestedStart: "2026-09-03T18:00", requestedEnd: "2026-09-03T19:00" }]);
    expect(latest.summary.days).toBe(1);
    expect(latest.complete).toBe(true);
  });

  it("選了未排班的日子但沒填開始時間不能送出，填了才完整", async () => {
    const days: Day[] = [scheduled("2026-09-03"), { date: "2026-09-05", startAt: null, hasExisting: false }];
    await render(days, 60);
    await act(async () => { latest.toggleDay("2026-09-03"); latest.toggleDay("2026-09-05"); });
    expect(latest.unscheduledDates).toEqual(["2026-09-05"]);
    expect(latest.missingUnscheduledStart).toBe(true);
    expect(latest.complete).toBe(false);

    await act(async () => { latest.setUnscheduledStartTime("19:00"); });
    expect(latest.missingUnscheduledStart).toBe(false);
    expect(latest.complete).toBe(true);
    expect(latest.entries).toContainEqual({ requestedStart: "2026-09-05T19:00", requestedEnd: "2026-09-05T20:00" });

    await act(async () => { latest.reset(); });
    expect(latest.summary.days).toBe(0);
    expect(latest.unscheduledStartTime).toBe("");
  });
});
