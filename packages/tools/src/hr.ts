import { AssistantError } from "@rueisiang/assistant";
import type { HrSelfLeaveQuery } from "@rueisiang/db";
import type { ToolContext, ToolContract } from "./contract.js";

export interface HrSelfToolService {
  authorize(): Promise<unknown>;
  leaveRequests(query: HrSelfLeaveQuery): Promise<unknown>;
  annualLeave(): Promise<unknown>;
}

function service(context?: ToolContext): HrSelfToolService {
  if (!context || (context.surface !== "sandbox" && (context.surface !== "line" || context.lineSourceType !== "user"))) {
    throw new AssistantError("HR 工具僅限 LINE 本人私訊。" );
  }
  // Sandbox 不從登入者推測本人；只有管理者隔離測試入口會注入受控的 hrSelf service。
  const value = context.services?.hrSelf;
  if (!value || typeof value !== "object" || !("authorize" in value) || typeof value.authorize !== "function") {
    throw new AssistantError("HR 本人授權服務不可用。" );
  }
  return value as HrSelfToolService;
}

function inputObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantError("HR 工具參數必須是物件。" );
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AssistantError("HR 工具不接受查詢對象或未定義的參數。" );
  return value;
}

const common = {
  defaultStatus: "enabled",
  surfaces: ["line", "sandbox"],
  lineSourceTypes: ["user"],
} as const;

export const HR_TOOL_DEFINITIONS: readonly ToolContract[] = [
  {
    ...common,
    key: "hr_authorize", label: "HR 本人授權",
    description: "每輪查詢本人 HR 資料前先呼叫。由可信 LINE 私訊或管理者限定的 HR 模擬本人模式，搭配現有員工綁定辨識本人，不能指定他人；token 由執行環境保管，不會回傳給模型。未綁定請引導使用既有 LINE HR 綁定頁，不接受姓名或員工編號驗證。",
    parameters: { type: "object", properties: {} },
    async execute(input, context) {
      inputObject(input, []);
      return JSON.stringify(await service(context).authorize());
    },
  },
  {
    ...common,
    key: "hr_get_my_leave_requests", label: "查詢本人假單",
    description: "先 hr_authorize，再查本人的假單核准狀態。還沒核准指 pending，不包含退回或取消；前幾天送出的用 submitted，請假日期用 leave（區間重疊）。最近請傳明確日期；無日期的 pending 查全部待審，其餘預設最近 30 天。不得查他人；時間顯示為台北時間，回傳 timestamp 是 UTC。回答必須說明查詢區間與是否還有下一頁，不可使用舊對話猜測 HR 資料。",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["all", "draft", "pending", "approved", "rejected", "cancelled"], description: "假單狀態，預設 all。" },
      dateField: { type: "string", enum: ["submitted", "leave"], description: "submitted 依申請日期，leave 依請假日期，預設 leave。" },
      fromDate: { type: "string", description: "台北日期 YYYY-MM-DD，與 toDate 一起傳入。" },
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 366 天。" },
      page: { type: "integer", description: "頁數從 1 開始，每頁最多 20 筆。" },
    } },
    async execute(input, context) {
      const value = inputObject(input, ["status", "dateField", "fromDate", "toDate", "page"]);
      for (const key of ["status", "dateField", "fromDate", "toDate"] as const) {
        if (value[key] !== undefined && typeof value[key] !== "string") throw new AssistantError("假單查詢參數格式不正確。" );
      }
      if (value.page !== undefined && typeof value.page !== "number") throw new AssistantError("頁數必須是整數。" );
      return JSON.stringify(await service(context).leaveRequests(value as HrSelfLeaveQuery));
    },
  },
  {
    ...common,
    key: "hr_get_my_annual_leave", label: "查詢本人特休",
    description: "先 hr_authorize，再查本人當期特休剩餘天數、時數與最後可使用日。依該期每日分鐘數換算天數；待審特休核准後才扣除。沒有當期額度不代表餘額零，不可自己推估，也不可使用舊對話回答。",
    parameters: { type: "object", properties: {} },
    async execute(input, context) {
      inputObject(input, []);
      return JSON.stringify(await service(context).annualLeave());
    },
  },
];

export function isHrToolKey(key: string): boolean {
  return HR_TOOL_DEFINITIONS.some((tool) => tool.key === key);
}
