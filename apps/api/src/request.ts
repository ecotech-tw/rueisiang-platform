import { HTTPException } from "hono/http-exception";

/**
 * 讀取請求內容的共用小工具。
 *
 * 收下來的 JSON 一律當成不可信輸入。等 Phase 2 之後有真正複雜的 payload
 * 再引入 zod——目前的驗證只有「是不是字串」「有沒有填」這種程度。
 */
export async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HTTPException(400, { message: "請求內容格式不正確。" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "請求內容不是有效的 JSON。" });
  }
}

export function requireString(input: Record<string, unknown>, field: string, label: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPException(400, { message: `請填寫${label}。` });
  }
  return value.trim();
}
