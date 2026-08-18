/**
 * CYBERBIZ API 的傳輸層。
 *
 * 三份舊實作各自重寫過這一段：CRM 的 lib/cyberbiz.ts 有一個 cyberbizRequest，
 * WMS 的 lib/cyberbiz-inventory.ts 則是在六、七個地方各自手寫
 * `Authorization: Bearer ${token}`。合成一份之後，重試、錯誤訊息、逾時這些
 * 只要改一個地方。
 *
 * 設定改成明確傳入而不是讀全域環境變數：Workers 沒有 process.env，env 是
 * 每個請求傳進來的；順帶讓測試不必去動全域狀態。
 */

export interface CyberbizConfig {
  /** 預設 https://app-store-api.cyberbiz.io，自架或測試環境才需要覆寫。 */
  baseUrl?: string;
  apiToken: string;
}

export const DEFAULT_BASE_URL = "https://app-store-api.cyberbiz.io";

/** CYBERBIZ 回非 2xx 時丟這個，呼叫端可以據此決定要不要重試。 */
export class CyberbizApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload: unknown,
  ) {
    super(`CYBERBIZ API ${status}: ${message}`);
    this.name = "CyberbizApiError";
  }

  /** 429 與 5xx 是暫時性的，值得重試；4xx 是我們送錯東西，重試幾次都一樣。 */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 從錯誤回應裡撈出能給人看的訊息。
 *
 * CYBERBIZ 的錯誤格式不只一種：有時是 { error: "..." }，有時是
 * { errors: ["...", "..."] }，有時是 { errors: { phone: ["已存在"] } }。
 * 三種都撈，撈不到就退回「請求失敗」，不要把整包 JSON 丟到使用者臉上。
 */
export function readErrorMessage(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return "請求失敗";

  const messages = [root.error, root.errors, root.message, root.detail]
    .flatMap((value) => {
      if (typeof value === "string") return [value.trim()];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
      }
      const record = asRecord(value);
      if (!record) return [];
      return Object.values(record)
        .flatMap((item) => (Array.isArray(item) ? item : [item]))
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim());
    })
    .filter(Boolean);

  return [...new Set(messages)].join("、") || "請求失敗";
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: Record<string, unknown>;
  /** 暫時性錯誤要再試幾次（不含第一次）。預設 2。 */
  retries?: number;
  /** 讓測試把等待時間縮成 0。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function cyberbizRequest(
  config: CyberbizConfig,
  path: string,
  options: RequestOptions = {},
): Promise<{ payload: unknown; headers: Headers }> {
  if (!config.apiToken) throw new Error("尚未設定 CYBERBIZ_API_TOKEN");

  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(2 ** (attempt - 1) * 500);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.apiToken}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const text = await response.text();
      let payload: unknown = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        // 有些錯誤會回純文字（例如上游的 502 HTML），至少把它留在訊息裡。
        payload = { message: text };
      }

      if (!response.ok) {
        const error = new CyberbizApiError(response.status, readErrorMessage(payload), payload);
        if (error.retryable && attempt < retries) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return { payload, headers: response.headers };
    } catch (error) {
      // 網路層的錯誤（連線中斷、DNS）也值得重試，但語法錯誤之類的不該吞掉。
      if (error instanceof CyberbizApiError && !error.retryable) throw error;
      if (attempt >= retries) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("CYBERBIZ 請求失敗");
}
