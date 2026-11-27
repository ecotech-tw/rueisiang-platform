import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Activity } from "./Activity.js";

const probe = vi.hoisted(() => ({
  refetch: vi.fn(async () => {}),
  invalidate: vi.fn(async () => {}),
  refresh: null as (() => void) | null,
}));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: () => {} }));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: (value: unknown) => value,
  useQueryClient: () => ({ invalidateQueries: probe.invalidate }),
  useQuery: () => ({ data: { events: [], page: 1, pageSize: 25, hasMore: false }, isPending: false, isFetching: false, refetch: probe.refetch }),
}));
vi.mock("../../ui/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../ui/index.js")>(),
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => {
    if (children === "重新整理") probe.refresh = onClick;
    return <button type="button" onClick={onClick}>{children}</button>;
  },
}));

describe("倉儲操作紀錄重新整理", () => {
  it("同時刷新列表與已展開的回補明細，避免保留過期查核入口", async () => {
    const html = renderToStaticMarkup(<Activity />);
    expect(html).toContain("官網訂單回補");
    expect(probe.refresh).not.toBeNull();
    probe.refresh?.();
    expect(probe.refetch).toHaveBeenCalledOnce();
    expect(probe.invalidate).toHaveBeenCalledWith({ queryKey: ["wms", "order-restock"] });
  });
});
