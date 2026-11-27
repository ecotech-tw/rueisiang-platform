import { AssistantError } from "@rueisiang/assistant";
import { AccountingError, findLineAccountBinding, getAssistantLineChannel, getAssistantLineMessage, submitLineExpense, type Database } from "@rueisiang/db";
import type { LineExpenseService, LineExpenseSubmission } from "@rueisiang/tools";
import type { Env } from "./env.js";
import { fetchLineMemberDisplayName } from "./line.js";
import { decryptLineSecret } from "./line-secrets.js";
import type { PiLineAgentRunRequest } from "./pi-agent-contract.js";

/*
 * LINE 報帳工具的執行端。申請人一律是「觸發這一輪的那則訊息」的發話者：從 webhook 存下來的訊息紀錄找 LINE userId，
 * 不採信模型給的任何身分。有綁定平台帳號（LINE 登入 channel 與 Messaging API 在同一個 provider，userId 相同，
 * HR 私訊授權也是這樣對應）就用本人；沒有就記 LINE 名稱（群組成員 API，對方不必加好友）。
 */

/** 名稱查不到（LINE API 失敗）時的退路；資料表要求沒綁定的人一定要有名稱，會計看得到 LINE userId 再去對。 */
const UNKNOWN_LINE_NAME = "LINE 使用者";

interface Sender { lineUserId: string; lineDisplayName: string; boundUserId: string | null }

async function shortDigest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class LineExpenseSubmitter implements LineExpenseService {
  private sender?: Promise<Sender>;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly input: PiLineAgentRunRequest,
  ) {}

  private async accessToken() {
    const channel = await getAssistantLineChannel(this.db, this.input.assistantKey);
    const stored = channel?.accessTokenEncrypted ? await decryptLineSecret(channel.accessTokenEncrypted, this.env.AUTH_SESSION_SECRET) : null;
    return stored || this.env.LINE_CHANNEL_ACCESS_TOKEN || null;
  }

  private async resolveSender(): Promise<Sender> {
    const message = await getAssistantLineMessage(this.db, { channelKey: this.input.channelKey, webhookEventId: this.input.webhookEventId });
    if (!message || message.lineGroupId !== this.input.lineGroupId || !message.lineUserId) {
      throw new AssistantError("認不出這則訊息是誰傳的，沒有送出報帳。");
    }
    const lineUserId = message.lineUserId;
    const loginChannelId = this.env.LINE_LIFF_CHANNEL_ID?.trim();
    const [binding, token] = await Promise.all([
      loginChannelId ? findLineAccountBinding(this.db, { channelId: loginChannelId, lineUserId }) : Promise.resolve(null),
      this.accessToken(),
    ]);
    const lineName = token
      ? await fetchLineMemberDisplayName(token, { sourceType: this.input.sourceType, chatId: this.input.lineGroupId, userId: lineUserId }, { channelKey: this.input.channelKey, groupId: this.input.lineGroupId })
      : null;
    return { lineUserId, lineDisplayName: lineName ?? UNKNOWN_LINE_NAME, boundUserId: binding?.userId ?? null };
  }

  async submit(item: LineExpenseSubmission) {
    this.sender ??= this.resolveSender();
    const sender = await this.sender;
    // 同一則訊息裡可能有好幾筆：識別碼用 webhook 事件加這筆的內容，重送同一筆不會重複，不同筆各自成立。
    const eventId = this.input.webhookEventId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);
    const clientRequestId = `line-${eventId}-${await shortDigest(`${item.spentOn ?? ""}|${item.amountDollars}|${item.description}`)}`;
    try {
      return await submitLineExpense(this.db, { clientRequestId, ...sender, spentOn: item.spentOn, amountDollars: item.amountDollars, description: item.description });
    } catch (error) {
      // 欄位不合規則（日期、金額、用途）回給模型一句話，讓小香照實告訴發話者。
      if (error instanceof AccountingError) throw new AssistantError(error.message);
      throw error;
    }
  }
}
