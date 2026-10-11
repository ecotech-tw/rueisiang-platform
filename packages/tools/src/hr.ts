import { AssistantError } from "@rueisiang/assistant";
import { listHrToolCalendar, type Database, type HrSelfLeaveQuery, type HrSelfOvertimeQuery, type HrSelfScheduleQuery, type HrToolCalendarQuery } from "@rueisiang/db";
import type { ToolContext, ToolContract } from "./contract.js";

export interface HrSelfToolService {
  authorize(): Promise<unknown>;
  leaveRequests(query: HrSelfLeaveQuery): Promise<unknown>;
  annualLeave(): Promise<unknown>;
  overtimeRequests(query: HrSelfOvertimeQuery): Promise<unknown>;
  schedule(query: HrSelfScheduleQuery): Promise<unknown>;
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

function stringFields<Key extends string>(value: Record<string, unknown>, keys: readonly Key[], message: string) {
  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new AssistantError(message);
  }
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
      stringFields(value, ["status", "dateField", "fromDate", "toDate"], "假單查詢參數格式不正確。");
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
  {
    ...common,
    key: "hr_get_my_overtime_requests", label: "查詢本人加班申請",
    description: "先 hr_authorize，再查本人的加班申請與核准狀態。還沒核准指 pending，不包含退回或取消；前幾天送出的用 submitted，加班日期用 work（區間重疊）。最近請傳明確日期；無日期的 pending 查全部待審，其餘預設最近 30 天。approvedStart／approvedEnd 是主管核定的實際時段，可能比申請的短，還沒核准是 null；settlementKind 的 pay 是領加班費、compensatory 是換補休。不得查他人；回傳時間都是台北時間。回答必須說明查詢區間與是否還有下一頁，不可使用舊對話猜測 HR 資料，也不要自己換算加班費金額。",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["all", "draft", "pending", "approved", "rejected", "cancelled"], description: "申請狀態，預設 all。" },
      dateField: { type: "string", enum: ["submitted", "work"], description: "submitted 依申請日期，work 依加班日期，預設 work。" },
      fromDate: { type: "string", description: "台北日期 YYYY-MM-DD，與 toDate 一起傳入。" },
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 366 天。" },
      page: { type: "integer", description: "頁數從 1 開始，每頁最多 20 筆。" },
    } },
    async execute(input, context) {
      const value = inputObject(input, ["status", "dateField", "fromDate", "toDate", "page"]);
      stringFields(value, ["status", "dateField", "fromDate", "toDate"], "加班查詢參數格式不正確。");
      if (value.page !== undefined && typeof value.page !== "number") throw new AssistantError("頁數必須是整數。" );
      return JSON.stringify(await service(context).overtimeRequests(value as HrSelfOvertimeQuery));
    },
  },
  {
    ...common,
    key: "hr_get_my_schedule", label: "查詢本人班表",
    description: "先 hr_authorize，再查本人已發布的班表：哪天上班、幾點到幾點、在哪個據點。不傳日期時查今天起 14 天；明天、下週請換算成明確日期再傳，最多涵蓋 62 天。每一天都會回傳，回答前先看三個欄位：scheduleStatus 是 assigned 而且 shifts 是空的，那天才是沒排班；not_published 代表那個月的班表還沒發布、not_assigned 代表班表發布了但還沒排到本人，都要照實說，不可以說成休假。attendanceMode 不是 scheduled 代表這位員工不是排班制，沒有逐日班表，也不可以說成休假。leaves 是當天的請假：有 approved 的請假時要一起說，那段時間不用上班；pending 是還沒核准，仍要照班表上班。dayType 是 weekday／weekend／holiday，holidayName 是假日名稱。不得查他人；時間都是台北時間，不可使用舊對話猜測班表。",
    parameters: { type: "object", properties: {
      fromDate: { type: "string", description: "台北日期 YYYY-MM-DD，與 toDate 一起傳入。" },
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 62 天。" },
    } },
    async execute(input, context) {
      const value = inputObject(input, ["fromDate", "toDate"]);
      stringFields(value, ["fromDate", "toDate"], "班表查詢參數格式不正確。");
      return JSON.stringify(await service(context).schedule(value as HrSelfScheduleQuery));
    },
  },
];

/**
 * 公司行事曆不是個資，所以不走 hr_authorize，群組也能用，也刻意不放進 HR_TOOL_DEFINITIONS——
 * 那份清單決定「哪些工具只能本人私訊、Sandbox 要先選模擬對象」，放進去會把它一起鎖起來。
 */
export const COMPANY_CALENDAR_TOOL: ToolContract = {
  // 鍵值刻意不用 hr_ 開頭：那個前綴目前都是「本人、要授權」的工具，用了遲早有人照名字猜它也要授權。
  key: "company_calendar", label: "查詢公司行事曆",
  description: "查公司行事曆上的國定假日、補班日與災防停班，回答「某個假期放幾天」「這週六要不要補班」「下個國定假日是哪天」。不傳日期時查今天起 60 天；請把連假、下個月換算成明確日期再傳，最多涵蓋 366 天。只會列出跟星期推算不同的日子：沒列出的週一到週五是平日、週六日是週末。makeupWorkday 為 true 是補班日；stopWork 是 all 代表全公司災防停班，是清單代表只有那些據點停班。note 有內容時代表該期間行事曆可能還沒設定，不可以回答成沒有假日。這是公司整體的行事曆，不代表個人班表；個人哪天上班要用本人班表工具。",
  defaultStatus: "enabled",
  surfaces: ["line", "sandbox"],
  parameters: { type: "object", properties: {
    fromDate: { type: "string", description: "台北日期 YYYY-MM-DD，與 toDate 一起傳入。" },
    toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 366 天。" },
  } },
  async execute(input, context) {
    const value = inputObject(input, ["fromDate", "toDate"]);
    stringFields(value, ["fromDate", "toDate"], "行事曆查詢參數格式不正確。");
    if (!context?.db) throw new AssistantError("這個工具目前沒有可用的資料來源。");
    return JSON.stringify(await listHrToolCalendar(context.db as Database, value as HrToolCalendarQuery));
  },
};

export function isHrToolKey(key: string): boolean {
  return HR_TOOL_DEFINITIONS.some((tool) => tool.key === key);
}
