import type { Env } from "./env.js";

/**
 * Upstash Redis 的 REST 介面。
 *
 * 從舊 WMS 的 lib/redis-cache.ts 搬過來，幾乎原封不動——**它本來就是 REST**，
 * 純 fetch over HTTPS，沒有 TCP 也沒有 Node 的 API，所以在 Worker 裡直接能跑。
 * （Workers 開不了原生的 Redis 連線，但 Upstash 的 REST 端點只是一個 HTTPS
 * 請求，那正好是 Worker 唯一做得到的形式。）
 *
 * 用的是同一個 Upstash 實例，不必另外開服務。
 */

/** 一次 MGET 最多幾個 key。再多 Upstash 會拒絕整個請求。 */
const MAX_MGET_KEYS = 250;
/** 一次 pipeline 最多幾道指令。同上。 */
const MAX_PIPELINE_COMMANDS = 200;

interface RedisReply<T> {
  result: T;
  error?: string;
}

export interface CacheClient {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setMany(entries: { key: string; value: string; ttlSeconds: number }[]): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * 沒設定就回 undefined，不要丟錯。
 *
 * 快取是加速用的，不是功能的一部分——沒有它的時候該慢慢跑，不是整個壞掉。
 * 呼叫端每一處都要能處理「沒有快取」這件事。
 */
export function cacheClient(env: Env): CacheClient | undefined {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;

  const command = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as RedisReply<T> | { error?: string };
    if (!response.ok || ("error" in payload && payload.error)) {
      throw new Error(`Redis 操作失敗：${payload.error || response.statusText}`);
    }
    return (payload as RedisReply<T>).result;
  };

  return {
    get: (key) => command<string | null>("", ["GET", key]),

    async mget(keys) {
      if (!keys.length) return [];
      const values: (string | null)[] = [];
      for (let index = 0; index < keys.length; index += MAX_MGET_KEYS) {
        values.push(...(await command<(string | null)[]>("", ["MGET", ...keys.slice(index, index + MAX_MGET_KEYS)])));
      }
      return values;
    },

    async set(key, value, ttlSeconds) {
      await command<string>("", ["SET", key, value, "EX", ttlSeconds]);
    },

    async del(key) {
      await command<number>("", ["DEL", key]);
    },

    async setMany(entries) {
      for (let index = 0; index < entries.length; index += MAX_PIPELINE_COMMANDS) {
        const chunk = entries.slice(index, index + MAX_PIPELINE_COMMANDS);
        const replies = await command<RedisReply<string>[]>(
          "/pipeline",
          chunk.map((entry) => ["SET", entry.key, entry.value, "EX", entry.ttlSeconds]),
        );
        const failed = Array.isArray(replies) ? replies.find((reply) => reply.error) : undefined;
        if (failed?.error) throw new Error(`Redis 批次寫入失敗：${failed.error}`);
      }
    },
  };
}
