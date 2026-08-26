import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NasStorageConfigError,
  NasStorageError,
  isNasStorageKey,
  nasStorageClient,
} from "./nas-storage.js";

const KEY = "assistant/vision/sandbox-chat/2026/08/00000000-0000-0000-0000-000000000001.png";
const LEGACY_KEY = "assistant/vision/2026/08/00000000-0000-0000-0000-000000000003.png";
const WMS_KEY = "wms/zones/zone-a/2026/08/00000000-0000-0000-0000-000000000002.png";
const REPORT_KEY = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000004.json";

afterEach(() => vi.restoreAllMocks());

describe("NAS storage client", () => {
  it("沒有設定時不啟用，設定不完整時明確失敗", () => {
    expect(nasStorageClient({})).toBeUndefined();
    expect(() => nasStorageClient({ NAS_STORAGE_URL: "https://storage.example.test" })).toThrow(NasStorageConfigError);
    expect(() => nasStorageClient({ NAS_STORAGE_TOKEN: "secret" })).toThrow(NasStorageConfigError);
  });

  it("上傳時只送 gateway 需要的 namespace、scope 與獨立 token", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/objects");
      expect(url.searchParams.get("namespace")).toBe("wms");
      expect(url.searchParams.get("scope")).toBe("zones");
      expect(url.searchParams.get("scopeId")).toBe("zone-a");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-storage-token")).toBe("storage-secret");
      expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
      expect(new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      return new Response(JSON.stringify({
        object: {
          key: WMS_KEY,
          size: 3,
          checksum: "0".repeat(64),
          contentType: "image/png",
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    });

    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test/", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: fetcher },
    );
    const body = new Uint8Array([1, 2, 3]).buffer;
    await expect(client!.put({
      namespace: "wms",
      scope: "zones",
      scopeId: "zone-a",
      contentType: "image/png",
      body,
    })).resolves.toMatchObject({ key: WMS_KEY, size: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("讀取 404 視為不存在，刪除 404 具備冪等性", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("image-bytes", { status: 200, headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: fetcher },
    )!;

    await expect(client.get(KEY)).resolves.toBeNull();
    const response = await client.get(KEY);
    await expect(response?.text()).resolves.toBe("image-bytes");
    await expect(client.delete(KEY)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("key=assistant%2Fvision%2Fsandbox-chat%2F2026%2F08%2F00000000-0000-0000-0000-000000000001.png");
  });

  it("報表上傳會帶 period 並接受 reports/cyberbiz object key", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("namespace")).toBe("reports");
      expect(url.searchParams.get("scope")).toBe("cyberbiz");
      expect(url.searchParams.get("scopeId")).toBe("store-a");
      expect(url.searchParams.get("period")).toBe("2026-07");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      return new Response(JSON.stringify({
        object: { key: REPORT_KEY, size: 2, checksum: "0".repeat(64), contentType: "application/json" },
      }), { status: 201 });
    });
    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: fetcher },
    )!;

    expect(isNasStorageKey(REPORT_KEY)).toBe(true);
    await expect(client.put({
      namespace: "reports",
      scope: "cyberbiz",
      scopeId: "store-a",
      period: "2026-07",
      objectId: "00000000-0000-0000-0000-000000000005",
      contentType: "application/json",
      body: new TextEncoder().encode("{}").buffer as ArrayBuffer,
    })).resolves.toMatchObject({ key: REPORT_KEY });
  });

  it("head 只回傳 NAS object metadata，找不到時回傳 null", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).searchParams.get("key")).toBe(REPORT_KEY);
      expect(init?.method).toBe("HEAD");
      return new Response(null, {
        status: 200,
        headers: { "content-length": "42", "content-type": "application/json" },
      });
    });
    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: fetcher },
    )!;

    await expect(client.head(REPORT_KEY)).resolves.toEqual({ key: REPORT_KEY, size: 42, contentType: "application/json" });
  });

  it("不接受任意路徑，gateway 的 HTML 錯誤也不會原樣流入平台", async () => {
    expect(isNasStorageKey(KEY)).toBe(true);
    expect(isNasStorageKey(LEGACY_KEY)).toBe(true);
    expect(isNasStorageKey("../secret")).toBe(false);

    const fetcher = vi.fn<typeof fetch>(async () => new Response("<html>blocked</html>", { status: 403 }));
    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: fetcher },
    )!;

    await expect(client.get("../secret")).rejects.toMatchObject({
      status: 400,
      code: "invalid_object_key",
    });
    await expect(client.get(KEY)).rejects.toMatchObject({
      status: 403,
      code: "storage_request_failed",
      message: "NAS storage gateway 回應 HTTP 403。",
    });
  });

  it("拒絕把 assistant 與 WMS 的 scope 混用", async () => {
    const client = nasStorageClient(
      { NAS_STORAGE_URL: "https://storage.example.test", NAS_STORAGE_TOKEN: "storage-secret" },
      { fetch: vi.fn<typeof fetch>() },
    )!;

    await expect(client.put({
      namespace: "assistant",
      scope: "zones",
      contentType: "image/png",
      body: new ArrayBuffer(1),
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_scope",
    } satisfies Partial<NasStorageError>);
  });
});
