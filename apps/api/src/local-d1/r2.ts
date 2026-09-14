import fs from "node:fs";
import path from "node:path";

/**
 * 用檔案系統實作 R2 的介面，給本機開發與測試用。
 *
 * 跟隔壁的 local-d1 是同一套思路：這台機器沒有 workerd（Windows on ARM），
 * 所以不能用 wrangler dev 的真 R2 模擬。與其把上傳那段程式碼在 dev 跟正式
 * 分成兩條路，不如補一個夠用的 R2 介面——路由跑的是同一份程式。
 *
 * 只實作平台真的會用到的四支（put / get / delete / head）。R2 還有分段上傳、
 * 條件請求、list 之類的，補上去只是增加沒人跑過的程式碼。
 */

interface LocalR2Object {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LocalR2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<void>;
  get(key: string): Promise<LocalR2Object | null>;
  head(key: string): Promise<{ key: string; size: number } | null>;
  delete(key: string): Promise<void>;
}

/** 中繼資料（content type、原始檔名）另外存一個 .json，R2 是連同物件一起存的。 */
interface StoredMeta {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export function createLocalR2(root: string): LocalR2Bucket {
  /*
   * key 會被拿去接檔案路徑，所以要擋掉往上跳的字元。這裡的 key 都是我們自己組的
   * （zones/<id>/<uuid>.jpg），但「目前的呼叫端很安全」不是不檢查的理由——
   * 之後多一個呼叫端就不一定了。
   */
  const resolve = (key: string): string => {
    const safe = key.split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
    return path.join(root, safe);
  };

  return {
    async put(key, value, options) {
      const file = resolve(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });

      let bytes: Uint8Array;
      if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());

      fs.writeFileSync(file, bytes);
      const meta: StoredMeta = {
        ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
        ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
      };
      fs.writeFileSync(`${file}.json`, JSON.stringify(meta));
    },

    async get(key) {
      const file = resolve(key);
      if (!fs.existsSync(file)) return null;
      const bytes = fs.readFileSync(file);
      let meta: StoredMeta = {};
      try {
        meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8")) as StoredMeta;
      } catch {
        // 中繼資料掉了不該讓圖片也讀不出來，回應那邊有 fallback 的 content type。
      }

      return {
        key,
        size: bytes.byteLength,
        ...meta,
        get body() {
          return new Response(bytes).body as ReadableStream<Uint8Array>;
        },
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
      };
    },

    async head(key) {
      const file = resolve(key);
      if (!fs.existsSync(file)) return null;
      return { key, size: fs.statSync(file).size };
    },

    async delete(key) {
      const file = resolve(key);
      // 已經不在了不算錯——R2 的 delete 對不存在的 key 也是靜默成功。
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.json`, { force: true });
    },
  };
}
