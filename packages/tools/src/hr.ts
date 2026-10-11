import { AssistantError } from "@rueisiang/assistant";
import { listHrToolCalendar, type Database, type HrRequestDraftInput, type HrSelfLeaveQuery, type HrSelfOvertimeQuery, type HrSelfScheduleQuery, type HrToolCalendarQuery } from "@rueisiang/db";
import type { ToolContext, ToolContract } from "./contract.js";

export interface HrSelfToolService {
  authorize(): Promise<unknown>;
  leaveRequests(query: HrSelfLeaveQuery): Promise<unknown>;
  annualLeave(): Promise<unknown>;
  overtimeRequests(query: HrSelfOvertimeQuery): Promise<unknown>;
  schedule(query: HrSelfScheduleQuery): Promise<unknown>;
  requestDraft(): Promise<unknown>;
  saveRequestDraft(input: HrRequestDraftInput): Promise<unknown>;
  cancelRequestDraft(): Promise<unknown>;
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

const REQUEST_QUERY_KEYS = ["status", "dateField", "fromDate", "toDate", "page"] as const;

/** 申請單查詢（假單、加班）共用的參數檢查；值域由 packages/db 的查詢把關，這裡只擋型別與多餘的鍵。 */
function requestQueryInput<Query>(input: unknown, message: string): Query {
  const value = inputObject(input, REQUEST_QUERY_KEYS);
  stringFields(value, ["status", "dateField", "fromDate", "toDate"], message);
  if (value.page !== undefined && typeof value.page !== "number") throw new AssistantError("頁數必須是整數。" );
  return value as Query;
}

const DATE_RANGE_PARAMETERS = {
  fromDate: { type: "string", description: "台北日期 YYYY-MM-DD，與 toDate 一起傳入。" },
} as const;

const common = {
  defaultStatus: "enabled",
  surfaces: ["line", "sandbox"],
  lineSourceTypes: ["user"],
} as const;

/**
 * 申請草稿的工具預設「開發中」，只在 Sandbox 出現。要在 LINE 開放得由管理者明確做兩件事：
 * 把這三個工具改成已啟用，並在 LINE 前台授權給 channel。這是會替員工建立真實申請的功能，
 * 不該因為部署了新版就自動對所有人打開。
 */
const draftCommon = { ...common, defaultStatus: "development" } as const;

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
      ...DATE_RANGE_PARAMETERS,
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 366 天。" },
      page: { type: "integer", description: "頁數從 1 開始，每頁最多 20 筆。" },
    } },
    async execute(input, context) {
      return JSON.stringify(await service(context).leaveRequests(requestQueryInput<HrSelfLeaveQuery>(input, "假單查詢參數格式不正確。")));
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
    description: "先 hr_authorize，再查本人的加班申請與核准狀態。狀態只有 pending（還沒核准）、approved、rejected；取消的加班申請會直接刪除，查不到，不可以回答成「沒有取消過」。前幾天送出的用 submitted，加班日期用 work（區間重疊）。不傳日期時：pending 查全部待審；其餘依加班日期查今天前後各 30 天，依申請日期查最近 30 天。要查更早或更晚請傳明確日期。approvedStart／approvedEnd 是主管核定的實際時段，可能比申請的短，還沒核准是 null；settlementKind 的 pay 是領加班費、compensatory 是換補休。不得查他人；回傳時間都是台北時間。回答必須說明查詢區間與是否還有下一頁，不可使用舊對話猜測 HR 資料，也不要自己換算加班費金額。",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["all", "pending", "approved", "rejected"], description: "申請狀態，預設 all。" },
      dateField: { type: "string", enum: ["work", "submitted"], description: "work 依加班日期，submitted 依申請日期，預設 work。" },
      ...DATE_RANGE_PARAMETERS,
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 366 天。" },
      page: { type: "integer", description: "頁數從 1 開始，每頁最多 20 筆。" },
    } },
    async execute(input, context) {
      return JSON.stringify(await service(context).overtimeRequests(requestQueryInput<HrSelfOvertimeQuery>(input, "加班查詢參數格式不正確。")));
    },
  },
  {
    ...common,
    key: "hr_get_my_schedule", label: "查詢本人班表",
    description: "先 hr_authorize，再查本人已發布的班表：哪天上班、幾點到幾點、在哪個據點。不傳日期時查今天起 14 天；明天、下週請換算成明確日期再傳，最多涵蓋 62 天。每一天都會回傳，回答前先看這幾個欄位：scheduleStatus 是 assigned 而且 shifts 是空的，那天才是沒排班；not_published 代表那個月的班表還沒發布、not_assigned 代表班表發布了但還沒排到本人，都要照實說，不可以說成休假。attendanceMode 是 general 代表這位員工不是排班制、沒有逐日班表，no_active_employment 代表查不到在職資料，兩種都不可以說成休假。leaves 是當天的請假：有 approved 的請假時要一起說，那段時間不用上班；pending 是還沒核准，仍要照班表上班。stopWork 不是 null 代表當天災防停班：all 是全公司，清單是停班的據點，班次的 scopeName 在清單裡才不用上班，有停班一定要講。dayType 是 weekday／weekend／holiday，holidayName 是假日名稱。不得查他人；時間都是台北時間，不可使用舊對話猜測班表。",
    parameters: { type: "object", properties: {
      ...DATE_RANGE_PARAMETERS,
      toDate: { type: "string", description: "包含此台北日期 YYYY-MM-DD，最多涵蓋 62 天。" },
    } },
    async execute(input, context) {
      const value = inputObject(input, ["fromDate", "toDate"]);
      stringFields(value, ["fromDate", "toDate"], "班表查詢參數格式不正確。");
      return JSON.stringify(await service(context).schedule(value as HrSelfScheduleQuery));
    },
  },
  {
    ...draftCommon,
    key: "hr_request_draft_get", label: "讀取本人申請草稿",
    description: "先 hr_authorize，再讀這位員工跟你講到一半的 HR 申請草稿（請假、加班或補打卡）。系統提示說有草稿時，回答前一定要先呼叫，因為你不記得上一輪問到哪裡；讀完之後，員工這一輪講的內容仍然要用 hr_request_draft_save 存進去。notes 是你之前留給自己的備忘（員工講過、還沒放進欄位的內容），跟員工這一輪講的合起來看：湊得出完整的欄位就存進欄位並清掉 notes。draft 是 null 代表沒有草稿。missing 是一定要有、還沒問到的欄位，一次只問員工一件事；optional 是可以不填的欄位（請假與加班的原因；補打卡的原因是必填，會出現在 missing），問一次就好，員工說不用就不要再問，也不要自己編一個；problem 有內容代表目前的時間不能請，照實告訴員工並請他改。leaveTypeOptions 是可以選的假別，remainingMinutes 是特休剩餘分鐘數。",
    parameters: { type: "object", properties: {} },
    async execute(input, context) {
      inputObject(input, []);
      return JSON.stringify(await service(context).requestDraft());
    },
  },
  {
    ...draftCommon,
    key: "hr_request_draft_save", label: "儲存本人申請草稿",
    description: "先 hr_authorize，再把員工剛剛講的內容存進申請草稿；沒有草稿會開一張新的。只傳這一輪新知道或要更正的欄位，其他欄位會保留。這個工具只存草稿，不會送出申請——你沒有送出申請的工具，絕對不可以說「已送出」「已申請」。欄位齊全時 status 會是 ready，系統會另外把確認卡片交給員工，由員工自己按確認才送出；你只要請他核對卡片並按確認。員工一說要申請就先呼叫這個工具開草稿，只知道種類也要存；之後他每講到一項就立刻再存。你不會記得上一輪，所以不可以先問「是不是這樣」等他回答才存。員工說的日期（「下週三」「明天」）由你換算成明確日期直接存，存完把存進去的日期（幾月幾號星期幾）、時間與其他內容念給他聽，請他有錯就說，他更正就再存一次。他完全沒講到的時間、假別、原因不要自己猜，問他；他只講了一半、還放不進欄位的（例如有日期沒有時間），寫進 notes，不可以因為放不進欄位就不存。員工一句話裡可能同時講了好幾件事（例如更正日期、又指定假別、又問別的問題）：存之前一項一項列出來，全部放進同一次呼叫，一項都不能漏；他更正申請內容（「不是…是…」「改成…」）時，更正後的值一定要存。回傳的 changed 是這一次真的改到的欄位：員工想改的那一項不在裡面、草稿裡的值也不是他要的，代表你漏了，補存一次；值已經對了就不用再存。回覆時明講這次改了什麼、哪些沒有變。這個工具回錯誤時，這一次帶的欄位都沒有存進去：把員工這一輪講的內容連同錯誤原因用 notes 再存一次，再告訴他原因。工具回錯誤時，把原因照實告訴員工。如果錯誤說已經有另一張還沒完成的草稿，要提醒員工那張還在，問他要繼續還是取消，不可以自己決定。加班要問的是哪一天、幾點到幾點、原因，時數要是半小時的倍數；本人申請的加班一律領加班費，不要問員工要加班費還是補休，他要補休的話請他洽 HR。補打卡要問的是補上班還是下班、實際的時間、為什麼沒打到；一張申請只補一次打卡，上下班都要補就先完成一張再開下一張。每一種申請只傳它自己的欄位。",
    parameters: { type: "object", properties: {
      kind: { type: "string", enum: ["leave", "overtime", "clock_correction"], description: "申請種類：leave 是請假，overtime 是加班，clock_correction 是補打卡。" },
      leaveTypeId: { type: "string", description: "只有請假要填：假別的 id，來自草稿的 leaveTypeOptions；不要傳假別名稱。" },
      startsAt: { type: "string", description: "請假或加班的開始，台北時間 YYYY-MM-DD HH:mm。" },
      endsAt: { type: "string", description: "請假或加班的結束，台北時間 YYYY-MM-DD HH:mm。" },
      clockEvent: { type: "string", enum: ["clock_in", "clock_out"], description: "只有補打卡要填：clock_in 是補上班打卡，clock_out 是補下班打卡。" },
      clockAt: { type: "string", description: "只有補打卡要填：實際上班或下班的時間，台北時間 YYYY-MM-DD HH:mm；一張只補一次打卡，不能是未來的時間。" },
      reason: { type: "string", description: "申請原因，用員工自己的話，最多 1000 字。請假與加班的原因可以不填，補打卡一定要有；員工沒有講就不要傳，不要替他編。" },
      notes: { type: "string", description: "備忘：員工講過、但還放不進上面欄位的內容，例如只說了日期沒說時間（「10/20 週二上午，還沒說幾點到幾點」）、只說了時間沒說哪一天、或剛剛存失敗的那句話與失敗原因。用白話寫，日期寫成幾月幾號，最多 500 字。你下一輪不記得這一輪，只看得到草稿，所以放不進欄位的一定要寫在這裡。每次傳都會整段取代舊的；欄位補齊、不再需要時傳空字串清掉。備忘不會出現在確認卡片，也不會送出。" },
    }, required: ["kind"] },
    async execute(input, context) {
      const keys = ["kind", "leaveTypeId", "startsAt", "endsAt", "clockEvent", "clockAt", "reason", "notes"] as const;
      const value = inputObject(input, keys);
      stringFields(value, keys, "申請草稿參數格式不正確。");
      if (typeof value.kind !== "string") throw new AssistantError("請提供申請種類。");
      return JSON.stringify(await service(context).saveRequestDraft(value as unknown as HrRequestDraftInput));
    },
  },
  {
    ...draftCommon,
    key: "hr_request_draft_cancel", label: "取消本人申請草稿",
    description: "先 hr_authorize，再取消這位員工講到一半的申請草稿。只有員工明確說不申請了、要取消、要重來時才呼叫；不要因為他換了話題就取消。這只會丟掉草稿，不會取消已經送出的申請。cancelled 是 false 代表本來就沒有草稿。",
    parameters: { type: "object", properties: {} },
    async execute(input, context) {
      inputObject(input, []);
      return JSON.stringify(await service(context).cancelRequestDraft());
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
  description: "查公司行事曆上的國定假日、補班日與災防停班，回答「某個假期放幾天」「這週六要不要補班」「下個國定假日是哪天」。不傳日期時查今天起 60 天；請把連假、下個月換算成明確日期再傳，最多涵蓋 366 天。只會列出跟星期推算不同的日子：沒列出的週一到週五是平日、週六日是週末。makeupWorkday 為 true 是補班日；stopWork 是 all 代表全公司災防停班，是清單代表只有那些據點停班。holidaysNotImportedYears 列出還沒匯入國定假日的年度：落在這些年度的日期不可以回答成沒有假日，要說行事曆還沒設定；清單是空的而 days 也是空的，才是這段期間真的沒有假日。這是公司整體的行事曆，不代表個人班表；個人哪天上班要用本人班表工具。",
  defaultStatus: "enabled",
  surfaces: ["line", "sandbox"],
  parameters: { type: "object", properties: {
    ...DATE_RANGE_PARAMETERS,
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
