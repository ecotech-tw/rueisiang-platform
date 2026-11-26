import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderRestockDetails } from "./OrderRestockDetails.js";

const view = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
  error: null as Error | null,
  pending: false,
  canResolve: false,
}));
vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(view.canResolve ? ["wms:sync:trigger"] : []) }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: view.data, error: view.error, isPending: view.pending }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, error: null, mutate: vi.fn(), reset: vi.fn() }),
}));

beforeEach(() => {
  view.canResolve = false; view.pending = false; view.error = null;
  view.data = {
    id: "restock-1", orderId: "700", orderName: "#700", phase: "create", sku: "SOAP", quantity: 5,
    variantId: "200", itemId: "soap", state: "observed", mode: "observe", remoteBefore: 12737,
    targetQuantity: 12742, remoteAfter: null, attempts: 1, reason: "觀察模式不寫入庫存",
  };
});

const render = () => renderToStaticMarkup(<OrderRestockDetails id="restock-1" />);

describe("回補明細的靜態介面狀態", () => {
  it("觀察模式不會把目標值冒充調整後結果", () => {
    const html = render();
    expect(html).toContain("僅觀察・未寫入");
    expect(html).toContain("12737"); expect(html).toContain("12742");
    expect(html).toContain("未確認／未寫入");
    expect(html).not.toContain("確認回補已完成");
  });

  it("讀取中與錯誤都有文字回饋，不只依賴動畫或顏色", () => {
    view.data = null; view.pending = true;
    expect(render()).toContain('role="status"'); expect(render()).toContain("讀取回補明細中");
    view.pending = false; view.error = new Error("權限不足");
    expect(render()).toContain("權限不足");
  });

  it.each([
    ["pending", "等待處理"], ["checking", "核對中"], ["applying", "送出中"],
    ["applied", "已確認調整"], ["unchanged", "無須調整"], ["skipped", "不適用／未執行"],
  ])("狀態 %s 有持續可見的文字標籤", (state, label) => {
    view.data = { ...view.data, state }; expect(render()).toContain(label);
  });

  it("唯讀人員看得到待確認原因，沒有人工結案入口", () => {
    view.data = { ...view.data, state: "review", mode: "apply" };
    const html = render();
    expect(html).toContain("待人工確認・不會自動重送");
    expect(html).not.toContain("確認回補已完成"); expect(html).not.toContain("人工查核說明");
  });

  it("有同步權限者要填查核說明，不能直接按下結案", () => {
    view.data = { ...view.data, state: "review", mode: "apply" }; view.canResolve = true;
    const html = render();
    expect(html).toContain("人工查核說明");
    expect(html).toContain("不會調整庫存或重新回補");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>確認回補已完成<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>確認未執行／已另行處理<\/button>/);
  });

  it("觀察模式的待確認工作不提供已完成調整按鈕", () => {
    view.data = { ...view.data, state: "review" }; view.canResolve = true;
    expect(render()).not.toContain("確認回補已完成");
    expect(render()).toContain("確認未執行／已另行處理");
  });
});
