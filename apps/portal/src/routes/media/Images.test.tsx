import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaImages } from "./Images.js";
import type { MediaImagePage } from "./api.js";
import { NAV_SECTIONS } from "../../shell/nav.js";

const mocks = vi.hoisted(() => ({ permissions: new Set<string>(), query: { data: undefined as MediaImagePage | undefined, isPending: false, isFetching: false, error: null as Error | null, refetch: vi.fn() } }));
vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: mocks.permissions }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: vi.fn() }));
vi.mock("./api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./api.js")>(), useMediaImages: () => mocks.query }));

const image = { id: "b21d8d9e-5143-4d0a-bec2-e3d230069b20", name: "官網主視覺<script>", filename: "banner.png", contentType: "image/png", size: 24000, width: 1200, height: 600, revision: 1, purgePending: false, purgeError: null, deletedAt: null, createdBy: "admin", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", url: "https://cdn.example.test/images/example", previewUrl: "/api/media/images/example/preview?revision=1" };
beforeEach(() => {
  mocks.permissions = new Set(["media:image:read", "media:image:write", "media:image:delete"]);
  mocks.query.data = { images: [image], total: 1, page: 1, pageSize: 24, configured: true, local: false, cdnOrigin: "https://cdn.example.test" };
  mocks.query.error = null; mocks.query.isPending = false;
});

describe("多媒體素材庫", () => {
  it("沿用側邊選單權限模型，獨立顯示多媒體管理入口", () => {
    expect(NAV_SECTIONS.find((section) => section.key === "media")).toMatchObject({ label: "多媒體管理", items: [{ to: "/media/images", permission: "media:image:read" }] });
  });
  it("顯示固定連結操作、格式與圖片尺寸，圖片預覽走受保護路由", () => {
    const markup = renderToStaticMarkup(<MediaImages />);
    for (const text of ["圖片素材庫", "複製連結", "圖片資訊", "1200", "600", "已同步 CDN", "上傳圖片"]) expect(markup).toContain(text);
    expect(markup).toContain("/api/media/images/example/preview?revision=1"); expect(markup).toContain("outline-black/10"); expect(markup).toContain("&lt;script&gt;"); expect(markup).not.toContain("<script>");
  });
  it("純讀取同仁不顯示上傳入口；未授權者顯示明確提示", () => {
    mocks.permissions = new Set(["media:image:read"]); expect(renderToStaticMarkup(<MediaImages />)).not.toContain(">上傳圖片</button>");
    mocks.permissions.clear(); const markup = renderToStaticMarkup(<MediaImages />); expect(markup).toContain("沒有檢視多媒體圖片的權限"); expect(markup).not.toContain("官網主視覺");
  });
  it("同步失敗與刪除後的狀態持續可見，不靠動畫表達", () => {
    mocks.query.data!.images = [{ ...image, purgePending: true, purgeError: "同步失敗" }, { ...image, id: "deleted", deletedAt: "2026-01-02T00:00:00.000Z" }];
    const markup = renderToStaticMarkup(<MediaImages />); expect(markup).toContain("待同步 CDN"); expect(markup).toContain("公開連結已失效"); expect(markup).toContain("圖片已刪除");
  });
  it("載入、空清單、讀取失敗與設定缺漏各有獨立提示", () => {
    mocks.query.data = undefined; mocks.query.isPending = true; expect(renderToStaticMarkup(<MediaImages />)).toContain("載入圖片中");
    mocks.query.isPending = false; mocks.query.error = new Error("讀取失敗"); expect(renderToStaticMarkup(<MediaImages />)).toContain("重新載入");
    mocks.query.error = null; mocks.query.data = { images: [], total: 0, page: 1, pageSize: 24, configured: false, local: true, cdnOrigin: "http://localhost:8787" };
    const markup = renderToStaticMarkup(<MediaImages />); expect(markup).toContain("還沒有圖片"); expect(markup).toContain("尚未完成 R2"); expect(markup).toContain("不連線正式 CDN");
  });
});
