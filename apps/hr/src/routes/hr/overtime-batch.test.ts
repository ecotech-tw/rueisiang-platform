import { describe, expect, it } from "vitest";
import { batchDialogItems, reviewableOvertimeBatches } from "./overtime-batch.js";

const item = (id: string, batchId: string | null) => ({ request: { id, batchId } });

describe("可以整批核准的待審加班", () => {
  it("同一個批次鍵還有兩筆以上待審才成一批；單筆申請與只剩一筆的批次不列", () => {
    const batches = reviewableOvertimeBatches([item("a", "batch-1"), item("b", null), item("c", "batch-1"), item("d", "batch-2"), item("e", "batch-3"), item("f", "batch-3")]);
    expect(batches.map((batch) => [batch.batchId, batch.items.map((entry) => entry.request.id)])).toEqual([["batch-1", ["a", "c"]], ["batch-3", ["e", "f"]]]);
    expect(reviewableOvertimeBatches([item("a", null), item("b", "batch-1")])).toEqual([]);
  });
});

describe("整批核准確認框的內容", () => {
  const opened = { batchId: "batch-1", items: [item("a", "batch-1"), item("b", "batch-1")] };

  it("清單重抓後用最新的待審；批次縮到只剩一筆也照列，不退回開啟時的內容", () => {
    expect(batchDialogItems([item("a", "batch-1"), item("b", "batch-1"), item("x", "batch-2")], opened)).toEqual({ items: [item("a", "batch-1"), item("b", "batch-1")], settled: false });
    expect(batchDialogItems([item("b", "batch-1"), item("x", null)], opened)).toEqual({ items: [item("b", "batch-1")], settled: false });
  });

  it("整批都處理完之後沿用開啟時的內容，並標成不能再送", () => {
    expect(batchDialogItems([item("x", "batch-2")], opened)).toEqual({ items: opened.items, settled: true });
  });
});
