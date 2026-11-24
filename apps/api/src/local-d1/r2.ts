import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Windows on ARM 的本機 R2；條件式 put 也在寫檔前原子檢查，避免測試掩蓋覆寫競爭。 */
interface StoredMeta {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}
interface LocalR2Head extends StoredMeta {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
}
interface LocalR2Object extends LocalR2Head {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface LocalR2Bucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream, options?: StoredMeta & {
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  }): Promise<LocalR2Head | null>;
  get(key: string): Promise<LocalR2Object | null>;
  head(key: string): Promise<LocalR2Head | null>;
  delete(key: string): Promise<void>;
}

export function createLocalR2(root: string): LocalR2Bucket {
  const resolve = (key: string) => path.join(root, key.split("/").map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/"));
  const head = (key: string): LocalR2Head | null => {
    const file = resolve(key);
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    let meta: StoredMeta = {};
    try { meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8")) as StoredMeta; }
    catch { /* 中繼資料損壞時仍提供檔案。 */ }
    const etag = createHash("sha256").update(bytes).digest("hex");
    return { key, size: bytes.byteLength, etag, httpEtag: `"${etag}"`, ...meta };
  };
  return {
    async put(key, value, options) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const current = head(key);
      const condition = options?.onlyIf;
      if (condition?.etagMatches !== undefined && (!current || (condition.etagMatches !== "*" && condition.etagMatches !== current.etag))) return null;
      if (condition?.etagDoesNotMatch !== undefined && current && (condition.etagDoesNotMatch === "*" || condition.etagDoesNotMatch === current.etag)) return null;
      const file = resolve(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(`${file}.json`, JSON.stringify({ httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata }));
      return head(key);
    },
    async get(key) {
      const object = head(key);
      if (!object) return null;
      const bytes = fs.readFileSync(resolve(key));
      return {
        ...object,
        get body() { return new Response(bytes).body as ReadableStream<Uint8Array>; },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
      };
    },
    async head(key) { return head(key); },
    async delete(key) {
      fs.rmSync(resolve(key), { force: true });
      fs.rmSync(`${resolve(key)}.json`, { force: true });
    },
  };
}
