// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { useTableBulkSelection, type TableBulkAction } from "@rueisiang/ui";

type Row = { id: string; status: "ready" | "locked" };
const actions: TableBulkAction<Row>[] = [{ id: "delete", label: "刪除", isEligible: (row) => row.status === "ready" }];

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("只有啟用批次動作後才選取合資格列，切換／退出會清除選取", () => {
  const rows: Row[] = [{ id: "one", status: "ready" }, { id: "two", status: "locked" }];
  function Harness() {
    const bulk = useTableBulkSelection(rows, (row) => row.id, actions);
    return createElement("div", null,
      createElement("button", { onClick: bulk.start }, "start"),
      createElement("button", { onClick: () => bulk.chooseAction("delete") }, "choose-delete"),
      createElement("button", { onClick: () => bulk.toggleRow(rows[0]!, true) }, "select-ready"),
      createElement("button", { onClick: () => bulk.toggleRow(rows[1]!, true) }, "select-locked"),
      createElement("button", { onClick: bulk.cancel }, "cancel"),
      createElement("output", null, `${bulk.active}:${bulk.actionId}:${bulk.selectedRows.map((row) => row.id).join(",")}`),
    );
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));
  const click = (index: number) => act(() => container?.querySelectorAll("button").item(index).click());

  expect(container.querySelector("output")?.textContent).toBe("false:null:");
  click(0);
  expect(container.querySelector("output")?.textContent).toBe("true:null:");
  click(3);
  expect(container.querySelector("output")?.textContent).toBe("true:null:");
  click(1);
  expect(container.querySelector("output")?.textContent).toBe("true:delete:");
  click(3);
  expect(container.querySelector("output")?.textContent).toBe("true:delete:");
  click(2);
  expect(container.querySelector("output")?.textContent).toBe("true:delete:one");
  click(4);
  expect(container.querySelector("output")?.textContent).toBe("false:null:");
});
