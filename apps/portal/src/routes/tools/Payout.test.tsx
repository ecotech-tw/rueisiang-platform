// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  statusRequestId: null as string | null,
}));

vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: () => undefined }));
vi.mock("./api.js", () => ({
  usePayoutState: () => ({
    isPending: false,
    error: null,
    data: {
      stores: [{ name: "測試店", scopeId: "cyberbiz:store:test", folder: "報表", folderUrl: "https://drive.google.com/drive/folders/test" }],
      defaultStart: "2026-07-01",
      defaultEnd: "2026-07-31",
      configured: true,
      runnerMode: "container",
      latestRequestId: null,
      runs: [],
    },
  }),
  usePayoutStatus: (requestId: string | null) => {
    mocks.statusRequestId = requestId;
    return { data: undefined, error: null };
  },
  useRunPayout: () => ({ isPending: false, error: null, mutate: mocks.mutate }),
}));

import { Payout } from "./Payout.js";

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.mutate.mockReset().mockImplementation((_input, options) => options.onSuccess({ requestId: "cf-new-run" }));
  mocks.statusRequestId = null;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("出金表執行狀態追蹤", () => {
  it("新工作狀態尚未回來時仍停用執行按鈕，避免重複排程", async () => {
    root = createRoot(host);
    await act(async () => root!.render(<Payout />));

    const submit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("全部執行"));
    expect(submit?.disabled).toBe(false);

    await act(async () => submit?.click());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.statusRequestId).toBe("cf-new-run");
    expect(submit?.disabled).toBe(true);
    expect([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "執行")?.disabled).toBe(true);
  });
});
