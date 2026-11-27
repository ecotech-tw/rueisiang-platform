import { AssistantError } from "@rueisiang/assistant";
import type { ToolContext, ToolContract } from "./contract.js";

/*
 * 在 LINE @小香 送報帳（使用者決定）：送出後跟 HR 員工自助送件一樣進「待審核」。
 *
 * 申請人是誰不由模型決定：工具只收日期、內容、金額，發話者由執行端從 webhook 的訊息紀錄找出來
 * （services.lineExpense），模型就算在參數裡寫了別人的名字也沒有作用。
 */

export const LINE_EXPENSE_TOOL_KEY = "accounting_expense_submit";

export interface LineExpenseSubmission { spentOn: string | null; amountDollars: number; description: string }

export interface LineExpenseService {
  submit(input: LineExpenseSubmission): Promise<{
    duplicate: boolean;
    bound: boolean;
    submitterName: string;
    spentOn: string;
    amountMinor: number;
    description: string;
    categoryName: string;
  }>;
}

function service(context?: ToolContext): LineExpenseService {
  if (context?.surface !== "line") throw new AssistantError("報帳只能在 LINE 對話裡送出。");
  const value = context.services?.lineExpense;
  if (!value || typeof value !== "object" || !("submit" in value) || typeof value.submit !== "function") {
    throw new AssistantError("LINE 報帳服務目前不可用。");
  }
  return value as LineExpenseService;
}

function submission(input: unknown): LineExpenseSubmission {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantError("報帳參數必須是物件。");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["spentOn", "description", "amount"].includes(key))) throw new AssistantError("報帳只收日期、內容與金額。");
  const spentOn = typeof value.spentOn === "string" && value.spentOn.trim() ? value.spentOn.trim() : null;
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const amount = typeof value.amount === "number" ? value.amount : typeof value.amount === "string" && /^\d+$/.test(value.amount.trim()) ? Number(value.amount.trim()) : Number.NaN;
  if (!description) throw new AssistantError("請說明這筆報帳買了什麼。");
  if (!Number.isSafeInteger(amount) || amount < 1) throw new AssistantError("金額必須是正整數元。");
  return { spentOn, amountDollars: amount, description };
}

/**
 * 預設「開發中」：會替人建立真實的報帳單，要由管理者把它改成已啟用、並在 LINE 前台授權給對話，才會出現在那個群組。
 */
export const LINE_EXPENSE_TOOL: ToolContract = {
  key: LINE_EXPENSE_TOOL_KEY,
  label: "LINE 報帳",
  description: "替這則訊息的發話者送出一筆報帳，送出後由會計審核。只在發話者明確要報帳、而且說了買了什麼與金額時使用；"
    + "沒說金額就先問，不要猜。一筆支出呼叫一次；同一則訊息有好幾筆就分開呼叫。不要替訊息裡提到的其他人報帳。"
    + "回覆時照實說明送出的日期、內容、金額與申請人；bound 為 false 時提醒會計會另外確認申請人、只能直接撥款。",
  defaultStatus: "development",
  surfaces: ["line"],
  lineSourceTypes: ["group", "room", "user"],
  parameters: {
    type: "object",
    properties: {
      spentOn: { type: "string", description: "消費日期，台北日期 YYYY-MM-DD。發話者沒說就不要傳，會用今天。說「昨天」等相對日期時換算成日期。" },
      description: { type: "string", description: "買了什麼、用途，照發話者的說法簡短寫，最多 500 字。" },
      amount: { type: "integer", description: "金額，新台幣整數元。" },
    },
    required: ["description", "amount"],
  },
  async execute(input, context) {
    const result = await service(context).submit(submission(input));
    return JSON.stringify({ status: result.duplicate ? "ALREADY_SUBMITTED" : "SUBMITTED", ...result, amountDollars: result.amountMinor / 100 });
  },
};
