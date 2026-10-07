import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StyleGuide } from "./StyleGuide.js";

describe("StyleGuide", () => {
  it("keeps the shared HRIS component catalog visible", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <StyleGuide />
      </MemoryRouter>,
    );

    for (const contract of [
      "HRIS 共用元件索引",
      "預覽 ConfirmDialog",
      "搜尋與篩選",
      "資料表、排序、分頁與空狀態",
      "sort-header",
      "pager",
      "segmented-control",
      "tooltip-anchor",
      "empty-state",
    ]) {
      expect(markup).toContain(contract);
    }
  });
});
