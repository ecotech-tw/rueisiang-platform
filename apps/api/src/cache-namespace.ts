import type { CacheClient } from "./upstash.js";

/**
 * 這一次查詢跟快取的關係。
 *
 * `bypass` 是沒有設定 Redis，`error` 是有設定但讀寫失敗——**兩者一定要分得開**。
 * 兩種情況都只是安靜地回去查資料庫的話，「secret 設了但快取其實一直在噴錯」
 * 跟「快取正常運作」從外面看完全一樣，D1 用量暴增時無從判斷。
 */
export type CacheStatus = "hit" | "miss" | "bypass" | "error";

export interface CachedValue<T> {
  value: T;
  status: CacheStatus;
}

export interface CacheNamespaceOptions {
  /** Redis key 前綴，同時是版本 key 的前綴。 */
  prefix: string;
  /** log 訊息裡的名字，例如「報表」。出問題時要看得出是哪一份快取。 */
  label: string;
  defaultTtlSeconds: number;
}

export interface CacheNamespace {
  read<T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<CachedValue<T>>;
}

function versionKey(options: CacheNamespaceOptions): string {
  return `${options.prefix}:version`;
}

/**
 * 帶版本命名空間的快取。
 *
 * 失效只刪版本 key，不必掃描整個 Redis——舊 entry 讀不到了，會等自己的 TTL 到期。
 * Redis 沒設定、讀寫失敗或內容損壞時都退回 loader：快取永遠不應該把功能本身變成
 * 故障點，但失敗要留下記錄。
 *
 * 一次請求用一個。同一個請求裡讀好幾組 key 時版本 key 只讀一次，不必每組各跑一趟。
 */
export function createCacheNamespace(
  cache: CacheClient | undefined,
  options: CacheNamespaceOptions,
): CacheNamespace {
  let sharedVersion: Promise<string> | undefined;

  async function currentVersion(): Promise<string> {
    if (!cache) return "";
    const existing = await cache.get(versionKey(options));
    if (existing) return existing;
    const created = crypto.randomUUID();
    await cache.set(versionKey(options), created, options.defaultTtlSeconds);
    return created;
  }

  return {
    async read<T>(
      key: string,
      loader: () => Promise<T>,
      ttlSeconds = options.defaultTtlSeconds,
    ): Promise<CachedValue<T>> {
      if (!cache) return { value: await loader(), status: "bypass" };

      let version: string;
      try {
        version = await (sharedVersion ??= currentVersion());
      } catch (error) {
        // 版本讀失敗會被記在共用的 promise 裡，重設才不會讓同一次請求的其他 key 全部跟著壞。
        sharedVersion = undefined;
        console.warn(`${options.label}快取版本讀取失敗，改查資料庫`, { key, error: String(error) });
        return { value: await loader(), status: "error" };
      }

      try {
        const cached = await cache.get(`${options.prefix}:${version}:${key}`);
        if (cached !== null) return { value: JSON.parse(cached) as T, status: "hit" };
      } catch (error) {
        /*
         * 單一 entry 讀不到或內容壞掉不代表版本有問題，所以不動 sharedVersion——
         * 丟掉一個有效的版本會讓同一次請求的其他 key 重跑一趟版本讀取，正是這裡
         * 要省的那一趟；剛好碰上版本到期的話還會鑄一個新版本，把 sibling 剛寫進去
         * 的 entry 變成孤兒。
         */
        console.warn(`${options.label}快取讀取失敗，改查資料庫`, { key, error: String(error) });
        return { value: await loader(), status: "error" };
      }

      const value = await loader();
      try {
        // Loader 執行期間可能剛好有人寫入而失效；只有 miss 時捕捉到的版本仍然有效，
        // 才能把結果寫回去，避免舊資料被寫進新的版本 namespace。
        if (await cache.get(versionKey(options)) === version) {
          await cache.set(`${options.prefix}:${version}:${key}`, JSON.stringify(value), ttlSeconds);
        }
      } catch (error) {
        // 寫入失敗不影響這次已經從資料庫算出的結果，但要看得到——寫不進去的話
        // 每一次請求都會是 miss。
        console.warn(`${options.label}快取寫入失敗`, { key, error: String(error) });
      }
      return { value, status: "miss" };
    },
  };
}

/** 以刪除版本 key 的方式讓整個命名空間立刻失效。 */
export async function forgetCacheNamespace(
  cache: CacheClient | undefined,
  options: CacheNamespaceOptions,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.del(versionKey(options));
  } catch (error) {
    // 資料已經寫成功；快取等 TTL 自然過期即可，不把錯誤往上丟。
    console.warn(`${options.label}快取失效失敗，最多等 TTL 到期`, { error: String(error) });
  }
}
