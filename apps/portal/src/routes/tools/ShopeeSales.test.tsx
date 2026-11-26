// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastShow: vi.fn(),
  run: {
    id: 1,
    status: "completed",
    conclusion: "success" as string | null,
    url: "",
    title: "request-id",
    driveUrl: "https://drive.google.com/file/d/file-id/view" as string | undefined,
    driveFileAlreadyExisted: false as boolean | undefined,
    ingested: true as boolean | undefined,
    salesRows: 12 as number | undefined,
    payoutRows: 3 as number | undefined,
    error: undefined as string | undefined,
  },
}));

vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: mocks.toastShow }) }));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: () => undefined }));
vi.mock("./api.js", () => ({
  useShopeeSalesState: () => ({
    isPending: false,
    error: null,
    data: {
      scopes: [{ id: "shopee:store:main", name: "蝦皮通路", driveFolderUrl: "https://drive.google.com/drive/folders/folder", driveFolderName: "蝦皮報表" }],
      start: "2026-02-01",
      end: "2026-02-28",
      configured: true,
      latestRequestId: "request-id",
    },
  }),
  usePreviewShopeeSales: () => ({ isPending: false, error: null, mutate: vi.fn() }),
  useConfirmShopeeSales: () => ({ isPending: false, error: null, mutate: vi.fn() }),
  useDiscardShopeePreview: () => ({ error: null, mutateAsync: vi.fn() }),
  useShopeePreview: () => ({ data: null, error: null }),
  useShopeeSalesStatus: () => ({ data: { runs: [mocks.run], steps: [] }, error: null }),
}));

import { ShopeeSales } from "./ShopeeSales.js";

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  mocks.toastShow.mockClear();
  mocks.run.status = "completed";
  mocks.run.conclusion = "success";
  mocks.run.driveUrl = "https://drive.google.com/file/d/file-id/view";
  mocks.run.driveFileAlreadyExisted = false;
  mocks.run.ingested = true;
  mocks.run.salesRows = 12;
  mocks.run.payoutRows = 3;
  mocks.run.error = undefined;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function mountImportRun() {
  sessionStorage.setItem("shopee-sales-tracking", JSON.stringify({ requestId: "request-id", mode: "import" }));
  root = createRoot(host);
  await act(async () => root!.render(<ShopeeSales />));
}

async function mountPreviewRun() {
  sessionStorage.setItem("shopee-sales-tracking", JSON.stringify({ requestId: "request-id", mode: "preview", previewToken: "preview-token" }));
  root = createRoot(host);
  await act(async () => root!.render(<ShopeeSales />));
}

describe("蝦皮報表完成通知", () => {
  it("匯入完成後通知結果並提供 Drive 連結", async () => {
    await mountImportRun();
    expect(mocks.toastShow).toHaveBeenCalledTimes(1);
    expect(mocks.toastShow).toHaveBeenCalledWith(
      "蝦皮報表完成：已上傳到 Drive，並匯入 D1（商品 12 筆、出金 3 筆）",
      "success",
      expect.objectContaining({ label: "開啟 Drive", onClick: expect.any(Function) }),
    );
  });

  it("不會把既有 Drive 檔案或自訂區間誤報成新上傳／D1 匯入", async () => {
    mocks.run.driveFileAlreadyExisted = true;
    mocks.run.ingested = false;
    mocks.run.salesRows = 0;
    mocks.run.payoutRows = 0;
    await mountImportRun();
    expect(mocks.toastShow).toHaveBeenCalledWith(
      "蝦皮報表完成：Drive 已有同名檔案，未重複上傳；此自訂區間未匯入 D1",
      "success",
      expect.objectContaining({ label: "開啟 Drive" }),
    );
  });

  it("解析與匯入時在狀態文字旁顯示動畫，按鈕只停用變灰", async () => {
    mocks.run.status = "in_progress";
    mocks.run.conclusion = null;
    await mountPreviewRun();

    const previewStatus = host.querySelector('[role="status"]');
    const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(previewStatus?.textContent).toBe("解析中…可以關閉這一頁");
    expect(previewStatus?.querySelector(".animate-spin")).not.toBeNull();
    expect(submitButton?.disabled).toBe(true);
    expect(submitButton?.getAttribute("aria-busy")).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    sessionStorage.clear();
    await mountImportRun();
    const importStatus = host.querySelector('[role="status"]');
    expect(importStatus?.textContent).toBe("匯入中…可以關閉這一頁");
    expect(importStatus?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("舊版工作沒有回報匯入欄位時不臆測 D1 結果", async () => {
    mocks.run.driveFileAlreadyExisted = undefined;
    mocks.run.ingested = undefined;
    await mountImportRun();
    expect(mocks.toastShow).toHaveBeenCalledWith(
      "蝦皮報表處理完成：Drive 處理完成；無法確認是否已匯入 D1，請檢查報表資料。",
      "info",
      expect.objectContaining({ label: "開啟 Drive" }),
    );
  });

  it("匯入失敗時顯示實際錯誤並通知失敗", async () => {
    mocks.run.conclusion = "failure";
    mocks.run.error = "Google Drive API 尚未啟用。";
    await mountImportRun();
    expect(host.textContent).toContain("Google Drive API 尚未啟用。");
    expect(mocks.toastShow).toHaveBeenCalledWith("蝦皮報表匯入失敗：Google Drive API 尚未啟用。", "danger");
  });
});
