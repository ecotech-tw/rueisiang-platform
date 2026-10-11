# 小香助理 Sandbox

這是 AI 內部問答系統的開發說明。Sandbox 與 LINE 前台現在共用 Pi Agent、SQLite Durable
Object session、tool loop 與 compact；在模型選單選 GPT 時使用 Codex ChatGPT OAuth，選
Gemini 時使用 `GEMINI_API_KEY`。架構、session 與 credential setup 見
[`line-pi-agent.md`](./line-pi-agent.md)；還沒做的部分見 README 的「下一步」。

## 本機操作

在 `apps/api/.dev.vars` 放入要測試的 provider credential（這個檔案不進版控）。只測 Gemini
時不需要 Codex credential；要測 GPT 時需要 `PI_CREDENTIAL_ENCRYPTION_KEY`，以及下列兩種方式
其中一種提供 OAuth credential：

```dotenv
GEMINI_API_KEY=你的_Gemini_API_Key
PI_CREDENTIAL_ENCRYPTION_KEY=至少_32_字元的獨立高熵字串
# 舊版本機 bootstrap 可暫時保留；正式環境建議從小香設定頁匯入後移除。
PI_OPENAI_CODEX_CREDENTIAL={"access":"...","refresh":"...","expires":4102444800000}
# 要讓已授權的 LINE 對話收到小香回答，還需要設定 Messaging API access token。
LINE_CHANNEL_ACCESS_TOKEN=你的_LINE_Channel_Access_Token
```

正式環境請在「小香助理 → 設定」貼上 Pi `auth.json` 匯入，不要把 rotation 後的新 refresh token
持續更新到 Worker secret。本機開發的 credential vault 是記憶體內 SQLite；重啟 API 後資料會重置，
需要重新使用 bootstrap JSON 或從設定頁匯入。

The LINE Channel Secret and Channel Access Token can also be entered in the LINE settings page. Both values are encrypted before they are stored; the existing `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` Worker variables remain fallback options.

啟動本機環境：

```powershell
pnpm dev
```

開啟啟動訊息印出來的「假登入」網址，選擇「林瑞翔」的假登入帳號，再進入「小香助理 → Sandbox」或「LINE 前台」。port 由 `pnpm dev` 自動挑並印在最前面（見 [`development-workflow.md`](./development-workflow.md) 的「本機 port」）。第一次啟動會自動套用 D1 migration，並建立預設 prompt revision、Open-Meteo tool 與 LINE channel 設定。

## 第一階段提供的功能

- 模型選單依 provider 分成 GPT／Codex（ChatGPT OAuth）與 Gemini／Gemma（API key），兩者都由目前安裝的 Pi provider catalog 提供，不另維護 AI Studio 模型／配額快照。一般對話不提供圖片生成、Live、研究或 computer-use 專用模型。credential 已設定只代表可嘗試請求，帳號權限、費用與配額以 provider 為準；`latest` 別名可能由上游更新。
- 同一個 Sandbox session 可以在每一輪送出前切換模型；切換會在該輪送出時套用，session 與每則模型回覆都會記錄實際使用的 model。
- Sandbox 選定模型後按「儲存並套用到小香」，會寫入 assistant 設定；Sandbox 與 LINE 後續沒有明確指定模型的執行都使用這個 active model。仍受支援的既有設定不自動變更；退役的主模型依既有規則回落、退役 fallback 暫停使用，兩者都會顯示提示，但讀取設定不改寫資料庫。管理者可直接儲存畫面上的回落值或確認「不使用 fallback」，不必先切換到別的選項；只儲存其中一個不會代替另一個確認。
- 編輯 system prompt；每次儲存會建立新 revision，並立即設為 active。
- Revision history 與 Sandbox tools 選擇都在 Modal 中操作；左側設定欄可獨立捲動，頁面外層不會跟著捲動。
- 選擇要傳給模型的 tool。目前內建唯讀工具預設為「已啟用」；管理者仍可切換成「開發中」或「已停用」。
- 輸入測試內容、看到模型回答、tool 呼叫結果、延遲與 provider usage metadata。
- 模型提供的 thought summary 會在 Sandbox 以收合區塊顯示；正式回答不會重複渲染，LINE 也只傳送正式回答。本輪 thoughts／usage 只從本輪 Pi `message_end` 事件收集，不依 transcript 陣列索引計算，以免 SDK 插入 system message 後重複計入歷史。
- 每次 Sandbox run 與 tool call 的狀態及用量都會寫入 D1；模擬員工本人的回合與一般回合一樣保存在操作者自己的 session，另外多寫一筆模擬稽核。
- 長對話由 Pi transcript 計算上下文；約 48,000 tokens 後透過 DO alarm compact，超過 80,000 tokens 時會在下一輪前強制 compact。D1 仍保留完整 user/model 訊息作 UI 與稽核投影，不是模型 context 的 source of truth。
- `小香助理 → LINE 前台` 可以設定 Channel ID、Channel Secret、Channel Access Token、channel 開關、Webhook URL 與對話授權。
- Channel Secret 與 Channel Access Token 透過後台輸入後會使用 `AUTH_SESSION_SECRET` 以 AES-GCM 加密保存，不會把原值回傳到瀏覽器。`LINE_CHANNEL_SECRET` 與 `LINE_CHANNEL_ACCESS_TOKEN` 仍可作為既有部署的環境變數 fallback。
- LINE webhook 只接受 LINE 的 `x-line-signature`；群組／多人聊天室的文字訊息只記錄真正 mention 小香的內容，圖片事件會先記錄並排入附件保存；一對一文字與圖片不需要 mention；新發現的對話預設未授權。
- LINE 圖片事件會由 Queue 透過 LINE Content API 取回，經由唯一的 storage connect layer 保存；目前 production adapter 使用 NAS gateway，assistant 圖片 key 為 `assistant/vision/<chat-id>/...`。一對一圖片只先保存，下一則文字才會觸發回答並帶入最近尚未消費的圖片。群組／多人聊天室圖片先保存 metadata，標註小香的文字可以讀取最近圖片而不必引用，也可以用 `quotedMessageId` 指定引用圖片；引用文字早於圖片落地時會先等待。圖片 metadata 預設保留 7 天，bytes 不進 D1。業務模組不直接依賴 NAS endpoint、token 或實體路徑；更換 S3 或自有 server 時只替換 connect layer 的 adapter 與設定。
- 已授權且開通的 LINE 對話會由 active model、active prompt 與狀態為「已啟用」的 tools
  產生回答；只有尚未建立 assistant 設定時才以 `PI_AGENT_MODEL` 作 fallback。一對一會同步使用者名稱與頭貼，「開發中」tool 仍只允許 Sandbox 使用。
- 一對一傳送 `/reset` 或 `/重設` 可清除目前模型上下文但保留歷史紀錄，不會觸發回答。

## 共用 Tool Contract：唯讀工具

CRM、WMS 與報表工具共用 provider-neutral `ToolContract`；目前這些唯讀工具都註冊在 Sandbox、LINE 與未來 MCP。小香 HR 本人查詢在正式 LINE 僅限私訊，Sandbox 則僅開放給管理者，並且要先在同一頁選定要模擬的員工；它不提供員工識別參數，群組與多人聊天室的工具目錄與執行入口都會排除 HR 工具。內建唯讀工具預設為「已啟用」，因此小香建立 channel 後即可使用完整工具集合；管理者仍可在後台把個別工具切換成「開發中」或「已停用」，LINE webhook 會尊重這個狀態。Sandbox 會依各工具宣告的 permission 檢查使用者權限。

- `crm_search_customers`：依關鍵字、來源、狀態、標籤與 `YYYY-MM-DD` 日期搜尋客戶；`dateField=createdAt` 代表當天新增，`dateField=updatedAt` 代表當天更新。
- `crm_get_customer`：依客戶 ID 取得客戶資料、標籤、同步狀態、最近操作紀錄與可選的消費摘要。
- `crm_get_orders`：即時查詢 CYBERBIZ 訂單，支援 customer ID、order ID、訂單編號、日期、狀態、排序與 limit；需要 `crm:order:read`。
- `hr_authorize`、`hr_get_my_leave_requests`、`hr_get_my_annual_leave`、`hr_get_my_overtime_requests`、`hr_get_my_schedule`：本人 HR 授權、假單狀態、當期特休、加班申請與已發布班表查詢。正式 LINE 僅限一對一私訊，群組及多人聊天室不提供此工具，亦不進入 HR 綁定或員工查核；Sandbox 目錄只對管理者列出 HR 工具，沒有選定模擬員工時不能送出。
- `company_calendar`：公司行事曆上的國定假日、補班日與災防停班。不是個資，不需要 `hr_authorize`，群組與多人聊天室也能用；它不在本人 HR 工具的清單裡，所以不受「只限私訊、Sandbox 要先選模擬對象」限制。
- `list_report_scopes`：列出啟用中的報表據點正式名稱與 scopeId；單一據點報表查詢遇到簡稱或不確定名稱時，先用它取得正式 `scopeName`。
- `query_sales_report`、`query_payout_report`：依月份、據點與篩選條件查詢已匯入 D1 的商品銷售或出金資料；需要 `reports:cyberbiz:read`。

目前 `mcp` 是共用 registry 的 surface 標記，實際 MCP transport adapter 尚未在本 repo 建立（要接**外部** MCP 工具的話有額外的限制與風險，見 [`assistant-multi-account-design.md`](./assistant-multi-account-design.md) 第五節）；未來 GPT、Gemini 或遠端 MCP host 都可沿用同一批 tool definition、執行函式與權限宣告。CYBERBIZ 訂單工具使用即時 API，不會把訂單快照寫入 CRM。

每次 Sandbox 與 LINE 執行都會注入可信的 `Asia/Taipei` 日期與時間，模型可以用它把「今天」轉成 CRM tool 的 `date`、`fromDate` 與 `toDate`。消費工具查不到連結資料時會明確回報，不會用姓名猜測客戶或捏造訂單。

HR 本人工具先依可信 LINE 私訊的 Messaging UID，在 `LINE_LIFF_CHANNEL_ID` scope 下查現有員工綁定、啟用帳號及在職狀態。LINE Login channel 與小香 Messaging API channel 必須屬於同一個 LINE Provider；HR 工具直接沿用既有小香 channel，不需要額外的 HR channel key。每輪授權 token 綁定 assistant、channel、私訊對話、session generation、run、LINE identity 與綁定版本，五分鐘到期且只留在該次 Pi 執行記憶體中。每次 HR 查詢重驗 token 並回 D1 重讀綁定、員工狀態與工具授權，解除／替換綁定會撤銷舊 token。

加班申請查詢的條件與分頁跟假單相同（`dateField` 是 `work` 或 `submitted`），兩處不同：狀態沒有 `cancelled` 與 `draft`（加班取消是直接刪列，也沒有流程寫入草稿）；依加班日期查的預設區間是今天前後各 30 天，因為加班多半事前申請。核定時段與申請時段分開回，不回申請原因。

班表查詢預設今天起 14 天、最多 62 天，讀的版本與出勤頁讀本人班表相同：同一期間最新的已發布版（`latestPublishedScheduleVersion`）。每一天都回一列並帶 `scheduleStatus`，整體帶 `attendanceMode`。班表版本以期間為單位、不分據點，而且存檔就是發布，所以 `scheduleStatus` 分三種：`not_published`（那個月還沒有人發布）、`not_assigned`（發布了，但這位員工在那一版裡一個班都沒有）、`assigned`（排到了，這時沒有班次才是真的沒排班）。`not_assigned` 與 HR 總覽的「還沒排的人數」是同一個想法但不是同一條規則：總覽看版本號最大的那一版（不管狀態）且只數排班制員工，是給 HR 看進度的；這裡回答的是員工實際該照哪一版上班。`attendanceMode` 是 `scheduled`（設定為排班制，或已發布班表裡真的有他的班，與請假算時數的判斷一致）、`general`（含沒有設定列）、`no_active_employment`。`scheduled` 以外與前兩種 `scheduleStatus` 都不是休假，工具把它們明講出來，模型才不會把沒有班次說成放假。

會讓「有班」變成「不用上班」的三件事跟班次一起回：當天核准與待審的請假（核准的假不會刪掉班次；封存任職上的假不算）、日型與假日名稱、災防停班（`stopWork`，形狀與行事曆工具相同）。LINE 的 HR 回合呼叫過 HR 工具後不能再呼叫行事曆工具，漏給就只能答成照常上班。

行事曆工具用 `holidaysNotImportedYears` 分辨「沒有假日」與「還沒匯入」：看的是涵蓋的年度有沒有任何國定假日列，不是查詢區間裡有沒有資料。這三個工具回給模型的時間都已轉成台北時間。

假單查詢只回本人必要欄位，pending 未指定日期時不設日期下限，其他未指定日期預設台北最近 30 天；每頁 20 筆，日期區間最多 366 天。特休查詢沿用本人年度額度及台帳，回報週期、到期日、分鐘／天數與待審時數，待審申請不扣餘額；額度補建只限定該員工。HR 回答與模型 tool-call transcript 不寫入 Pi Durable Object、LINE reply backup 或回答 log；Reply／Push 送出前重新確認有效綁定與授權期限。

開通時先由 CI 套用新增 `link_version` 欄位的 migration，再設定 `LINE_LIFF_CHANNEL_ID`，並在既有小香 channel 工具授權中勾選 HR 工具；之後新增的工具（含行事曆）同樣不會自動授權給既有 channel，要到 LINE 前台勾選。實機 smoke 必須包含本人／他人隔離、未綁定、離職／停權、查詢後解除綁定、群組與多人聊天室。回滾時停用本人 HR 工具，再回退 Worker；保留新增欄位與綁定版本，不刪資料、不反向重建表。

Open-Meteo 是無 API key 的公開測試 API；目前只用來驗證 tool calling，不是公司的知識來源，也不應被視為正式內部問答能力。後續 WMS、CRM 與公司文件搜尋會以同一個 `ToolContract` 介面接入，MCP adapter 會放在這層之下。

## 模擬員工本人

Sandbox 設定欄的「模擬員工本人」要求操作者具有系統 `admin` 角色及 `assistant:sandbox:write` 權限。員工選擇器可搜尋姓名、員工編號並分頁，只回必要名稱、帳號狀態及目前 `LINE_LIFF_CHANNEL_ID` 下的綁定狀態，不回 LINE UID 或綁定版本。未啟用或未綁定的在職員工仍可選擇，用來測試授權拒絕；真正查詢仍要求啟用帳號、在職狀態及現有綁定。HR 工具的啟用、開發中與停用由小香設定頁統一管理；管理者的設定頁與 Sandbox 用同一份含 HR 的工具目錄，非管理者的目錄不含 HR。

選定員工的 user ID 只交給受權限保護的 Sandbox run 入口，模型工具不接受查詢對象。token 綁定 assistant、Sandbox HR scope、操作者、對話、run、LINE Login identity 與綁定版本，五分鐘到期並只保存在本輪執行記憶體中。與正式 LINE 共用 token 驗證及本人資料 view；帶模擬對象的回合，每次工具查詢、DO 回應及 HTTP 回覆前均重驗操作者、員工綁定與有效授權。解除／替換綁定、停權、離職、撤銷管理角色或工具停用會立即阻擋。

模擬員工本人不是另一個模式，而是 Sandbox run 上的一個設定：同一輪可以混用一般工具與 HR 工具、接在既有 session 後面多輪對話，也可以附圖。選了 HR 工具就必須一併提供 `hr_authorize`，沒有選定員工時 HR 工具不能送出；「開發中」工具可在 Sandbox 測試。問答、思考與工具參數照一般 Sandbox 保存在操作者自己的 session 與 Pi transcript，只有建立 session 的人讀得到；不寫 LINE backup，也不傳送 LINE 訊息。模擬回合在 DO 跑完後先停在 `awaiting_delivery`，路由在 HTTP 送出前重驗操作者、綁定與授權，通過才呼叫 `/commit-run` 讓它算進對話；沒通過的回合不會成為任何一輪的上下文或摘要。一段對話只能模擬一位員工：跑過 HR 工具之後再帶另一位員工會被拒絕，要換人先清除對話；畫面在切換或清除對話時也會取消選取。對話裡一旦有某位員工的資料，之後同一段對話的每一輪——不管有沒有帶模擬對象、有沒有呼叫 HR 工具——開始前與回答算數前都重驗操作者仍是管理者、這位員工仍有綁定、帳號啟用且在職；不通過就拒絕並要求清除對話，模型不會被呼叫。這擋的是「叫模型複述」；先前已顯示過、存在 D1 的訊息，操作者仍能從自己的 session 讀回，要收回只能關閉或清除那段對話。一段對話只要跑過 HR 工具，之後同一段對話的每一輪與背景 compact 的 provider／transport 錯誤都遮罩成固定句子，不把回顯的內容寫進畫面、Worker Logs 或 run 稽核——HR 內容進了 transcript 就會跟著之後每一輪送出，不是只有帶模擬對象的那一輪；清除對話才恢復。只選了員工、沒跑到 HR 工具的對話不遮罩；我們自己寫的錯誤（未綁定、已停權、圖片過期、session 已關閉）照常顯示。HTTP 回覆使用 `Cache-Control: no-store`。正式資料會送至所選模型服務，畫面在選定員工時提示這項邊界。

模擬員工本人只需既有的 `LINE_LIFF_CHANNEL_ID` 綁定 scope，不依賴 Messaging channel 開關或正式 LINE 對話的工具白名單。這讓管理者能在正式 LINE 開通前測試本人資料，但不代表正式 LINE 授權或 UID Provider 相容性已通過驗證。特休額度仍沿用本人補建規則，不會補建其他員工。

## HR 申請草稿

員工可以跟小香講話來準備 HR 申請。模型只有三個工具：`hr_request_draft_get`、`hr_request_draft_save`、`hr_request_draft_cancel`，都是本人 HR 工具（先 `hr_authorize`、LINE 僅限私訊、Sandbox 要先選模擬對象）。**沒有送出的工具**：模型只能把員工講的內容存成草稿。

草稿存在 `assistant_hr_request_drafts`，不是 HR 的申請單——HR 的表不知道它存在。這樣設計有兩個理由：LINE 的 HR 回合不留 transcript，下一輪模型不記得上一輪問到哪裡，進度只能放在資料庫；而送出不能由模型判斷「好」是在回哪一件事。

- 每次 `save` 只帶這一輪新知道的欄位，回傳 `missing`（一定要有、還沒問到的）與 `optional`（可以不填、還沒填的）。必填與選填照 HR 頁面那張表單走：請假與加班的原因是選填。兩個時間都有了就用 HR 的規則試算（`checkHrSelfLeaveRequest`／`checkHrSelfOvertimeRequest`：時段合不合法、找不找得到審核者），不合法當場回錯誤；任何欄位不合法整次不存。
- 欄位齊全時 `status` 是 `ready`，並由程式（不是模型）用草稿排出固定格式的確認卡片。
- 一段對話同時只有一張進行中的草稿。已經有一張時不會自動換掉，工具回錯誤要模型提醒員工那張還在、問他要繼續還是取消。
- 草稿 24 小時沒有更新就視為不存在。
- 這一輪拿得到存草稿的工具時，路由每一輪都在 system prompt 放一段規則（`hrRequestDraftPromptRules`），並告訴模型這段對話現在有沒有草稿（只講有與種類，不帶欄位）。規則的核心是「先存，再複述」：員工一說要申請就先開草稿，之後每講到一項就先存再回覆，存完把存進去的內容念給員工聽、請他有錯再更正。不能反過來「先確認再存」——模型下一輪不記得上一輪，它問完「是 10/20 嗎」，等員工回答時已經忘了員工講過的時間。規則只在這一輪真的走得通時才給：讀與存草稿的工具都拿得到，而且（在 LINE 上）LINE Login 已設定、這個帳號有綁定員工。
- 欄位只收完整的日期加時間，所以草稿另有一個白話的 `notes`：員工只講了一半（有日期沒時間）或存檔被拒絕時，模型把他講的內容寫在這裡，下一輪讀草稿時看得到。`notes` 不進確認卡片、不會送出。存檔失敗時，這一次帶的欄位一個都不存，但草稿本身（第一次存就失敗也會開一張只有種類的草稿）與 `notes` 會留下——那一輪不留 transcript，什麼都不留的話下一輪模型連員工在申請什麼都不知道。

### 在 LINE 上確認與送出

草稿存齊的那一輪，LINE 的最終回覆後面會接兩則訊息：固定格式的卡片（文字），以及只有「確認送出」「取消」兩顆按鈕的 confirm template。卡片放在文字訊息裡是因為 template 的文字上限 240 字，而請假原因最多 1000 字。Reply 來不及改走 Push 時，這兩則一樣跟著送。

按鈕是 postback，帶的資料只有 `hr_draft:<submit|cancel>:<草稿 id>:<版本>`。按下去之後走 `confirmLineHrDraft`，**不進 Queue、不經過模型**：

1. 只處理一對一私訊，而且 channel 與這段對話都要啟用。
2. 按的人是誰由 `resolveLineHrRequestActor` 決定，檢查與 HR 工具是同一套：LINE 綁定有效、帳號啟用、在職、這個私訊有被授權 `hr_request_draft_save`。工具被停用或授權被收回，按鈕也跟著失效。
3. `confirmHrRequestDraft` 確認草稿是這個人、這段對話的，版本與按鈕上的一致（草稿之後又改過的話，舊卡片的按鈕失效），再照現在的規則重算一次能不能送。
4. 先把草稿從 `open` 改成 `submitted`（搶到的才往下走），再呼叫 HR 頁面用的建立函式（請假 `createHrLeaveRequest`、加班 `createHrOvertimeRequest`、補打卡 `createAndSubmitHrClockCorrection`）。連按兩下或 LINE 重送 webhook，第二次都搶不到。HR 拒絕建立時草稿退回 `open`，員工可以改了再送。
5. 回覆是固定句子（`hrRequestDraftConfirmationReply`），不是模型產生的。

第 4 步的幾個動作不在同一個 transaction 裡，每一個中斷點都落在「不會多送」那一邊：搶到之後、建立之前中斷，會留下一張 `submitted` 但沒有 `submitted_request_id` 的草稿，申請沒有建立；建立成功之後才失敗（例如把申請 id 記回草稿那一步），申請已經存在，草稿維持 `submitted`。只有建立函式自己丟出錯誤才會把草稿退回 `open`；如果那次寫入其實已經進了資料庫（結果不明的失敗），擋住第二張的是 HR 自己的規則——請假與加班的時段重疊、補打卡的同一個時間點。補打卡是「建立、再送出」兩步，清不乾淨時留下的是一張 HR 頁面看得到的 draft，不是多一張待審申請。

草稿跟著「這段對話裡現在這個人」走：

- 員工傳 `/reset` 會把還開著的草稿一起收掉，之前發出去的確認卡片跟著失效。
- LINE 帳號解除綁定後綁給另一位員工時，前一個人留下的草稿對新的人來說不存在：不會出現在提醒裡、讀不到、按舊卡片送不出去；他開始自己的申請時那張作廢。

### 開通

三個工具的預設狀態是「開發中」，所以部署後只在 Sandbox 出現。Sandbox 會顯示確認卡片的預覽，但按鈕是停用的：模擬本人的管理者不能替員工送出真的申請。要在 LINE 開放，管理者要明確做兩件事：在小香設定頁把三個工具改成「已啟用」，並在 LINE 前台把它們授權給 channel。回滾時把 `hr_request_draft_save` 停用即可：模型存不了草稿，已經發出去的按鈕也會失效。

草稿的種類有請假、加班與補打卡。補打卡一張只補一次打卡，問的是補上班還是下班、實際的時間與原因（必填，跟 HR 頁面的表單一樣）；審核者固定是直屬主管，沒有直屬主管的人請他回 HR 頁面自己指定。HR 頁面的補打卡是「存草稿、再送出」兩步，對話的草稿存在小香那邊，確認時由 `createAndSubmitHrClockCorrection` 一次做完，送出被擋就把剛建立的那一列刪掉。每一種申請只收自己的欄位，傳了別種的欄位會被拒絕。加班只問起訖時間與原因：本人申請的加班一律領加班費（`hr-overtime` 的規則），所以不問結算方式；試算用 `checkHrSelfOvertimeRequest`，與建立時跑的是同一組檢查，時段重疊則要到送出、由資料庫仲裁時才知道。每一種申請在 `assistant-hr-drafts.ts` 是一個 handler（怎麼併欄位、怎麼算、怎麼送出），草稿的生命週期不分種類。

## 錯誤診斷與 Cloudflare logs

每次 Sandbox 執行都會產生一個診斷編號；run、tool 執行、耗時與錯誤會寫入 D1，Pi Agent 與 tool 的執行錯誤也會寫到 Worker Logs。模擬員工本人的回合另以操作者 ID、目標員工 ID 及 run ID 稽核模擬操作。Sandbox 只顯示 tool 的實際參數；credential、完整 prompt 與完整對話不會寫入 Worker log。

每一則模型回覆的「工具調用」都可以展開查看參數；如果 provider 在工具執行後的下一輪請求失敗，Sandbox 也會在錯誤下方保留該次失敗前的工具調用，方便比對模型送出的參數。

正式環境可在 Cloudflare Dashboard 的 Workers & Pages → `rueisiang-platform` → Observability 查詢 `Pi chat agent 執行失敗`，並以 D1 的 run 診斷編號對照。也可以在有 Wrangler 的環境即時查看：

```bash
npx wrangler tail rueisiang-platform --format json
```

目前 `apps/api/wrangler.toml` 已啟用 `[observability]`；修改程式後需部署一次，新的 structured logs 才會出現在 Cloudflare。Windows on ARM 本機因 Wrangler 的 `workerd` 不支援，建議使用 Cloudflare Dashboard 或 Linux/CI 執行 `wrangler tail`。

## LINE 回覆的執行方式與延遲診斷

LINE webhook 收到訊息後會先把工作寫入 Cloudflare Queue，再回傳 `accepted`；Queue consumer
負責 dispatch 到 chat 專屬 Durable Object，由 Pi Agent 依 active model 執行 Codex 或 Gemini、tool 與 session context，
完成後再呼叫 LINE Messaging API。正常路徑永遠優先使用 webhook event 的
`replyToken`；Queue 不設定 delivery delay。距離程式採用的 60 秒期限只剩 10 秒時，若推論仍未
完成，會先用 Reply API 回覆「系統繁忙，請稍後再試。」。完整結果完成後才嘗試受限 Push；
若 Push 不可用或額度已滿，完整結果仍會保存到 D1 的對話 relation，供系統備查。

Push 是 fallback，不是一般回覆 transport。台灣免費方案上限固定為每月 200 位收件者；本服務因 LINE usage 回報是 approximate，實際預約上限保守設為 195，預留 5 位緩衝；月份
依 LINE 官方計費時區 GMT+9 的 `YYYY-MM` fixed window 計算。每次 Push 嘗試都寫入
`assistant_line_push_deliveries`，群組／room 依成員數而不是 API 呼叫次數扣額度。本地 ledger
會和 LINE quota consumption API 的回報取較高用量，失敗預約不釋放；Queue consumer 因此固定
`INSERT ... SELECT` 預約收件人數；Queue consumer 設定 `max_concurrency = 1`，讓 LINE 工作依序完成，
避免同一群組／聊天室因為較慢的 CYBERBIZ tool 而交錯回覆。額度正確性不依賴 consumer 的串行化。
Push 另帶與 Queue run 相同的 `X-Line-Retry-Key`，避免 consumer 重試造成
重複訊息。

每次 LINE 執行會使用同一個 `runId` 寫入 `assistant.run.*`、`assistant.line.reply.*`、`assistant.line.message.*` 與 Queue structured logs。請用 `runId` 搭配 `webhookEventId`、`channelKey`、`groupId` 比對以下事件：

- 沒有 `assistant.run.started`：工作沒有成功排入背景，或 webhook 在授權／設定階段就結束。
- 有 `assistant.run.failed`、沒有 `assistant.line.reply.started`：模型、tool 或設定失敗。
- 有 `assistant.line.reply.failed`：LINE Reply API 回傳錯誤；常見原因是 reply token 過期、重複使用或 message 格式錯誤，log 會保留 HTTP status 與受限長度的 API response。
- 有 `assistant.line.message.error` 或 `assistant.line.message.transport_error`：可查看 endpoint、HTTP status／timeout、duration 與受限長度的 response；transport timeout 不能判定 LINE 是否已收件，因此不會自動再送一份 Push。
- 有 `assistant.line.reply.completed` 但群組仍無訊息：檢查 LINE webhook event 是否真的帶入對應的 reply token，以及該 token 是否已被其他執行消耗。
- 有 `assistant.line.push.completed`：Reply 已進入逾時 fallback，完整回答已在保守的 195 人 fixed window 內用 Push 送出。
- 有 `assistant.line.push.skipped`：成員數／遠端用量取不到，或本月保守額度已滿；完整回答查 `assistant_line_reply_backups`。
- 有 `assistant.line.push.failed`：已預約的收件人數仍保留，不因重試競態釋放；完整回答同樣留在備用表。
- 有 `assistant.line.queue.consumer_retry`、`assistant.line.queue.retry_exhausted`、`assistant.line.queue.outbox_replay_failed` 或 Cloudflare DLQ 訊息：表示 Queue／D1／AI／LINE transport 重試後仍未完成，可用同一組 correlation fields 追完整鏈路。`failed` 工作不會再被 outbox 重送；Push retry key 超過 24 小時則記為 `ambiguous`，等待 reconciliation。

tool 失敗不會立即產生固定錯誤文字；失敗結果會回傳目前執行中的模型，讓它產生可理解的說明。
Sandbox 會保留該次 tool 的 args 與失敗訊息，LINE 只會收到 Pi Agent 的最終回答。LINE 的 AI
工作已經透過 Cloudflare Queues 與 webhook 解耦。

## API

Sandbox runs support multi-turn Pi sessions. D1 keeps the selected model, prompt revision, and full user/model history as metadata and an audit/UI projection; the chat Durable Object keeps the Pi transcript and compact summary used for inference. The model in `POST /api/assistant/sandbox/run` takes precedence for an open session, so each turn can switch providers or models; close a session to keep its D1 history while preventing further runs.

- `GET /api/assistant/sandbox/sessions`、`POST /api/assistant/sandbox/sessions`：列出或建立 Sandbox session。
- `GET /api/assistant/sandbox/sessions/:id`、`POST /api/assistant/sandbox/sessions/:id/close`：查看或關閉 session。
- `POST /api/assistant/sandbox/run`：帶入 `sessionId` 時，會 dispatch 到該 session 專屬 Pi DO；第一次使用既有 session 時會從 D1 匯入最近 100 則訊息，之後由 Pi transcript 接續。若指定 `model`，會套用到本輪並更新開啟中的 session。

- `GET /api/assistant/sandbox/config`：模型、tool、active prompt 與 revision history；管理者的 tool 目錄含 HR 工具，`hrSandbox` 標示能否模擬與哪些 key 屬於 HR。
- `GET /api/assistant/sandbox/hr/employees`：管理者限定的模擬員工清單，支援 `search` 與 `page`，每頁 25 筆。
- `POST /api/assistant/sandbox/run` 的 `hrSandboxUserId`：管理者限定，指定這一輪要模擬的員工；可與 `sessionId`、圖片及一般工具並用，不回傳 token、LINE UID 或內部授權資料。
- `POST /api/assistant/codex-credential`：由具備設定寫入權限的管理者匯入 Pi／Codex `auth.json`；只回傳 vault 狀態，不回傳 credential 原值。
- `POST /api/assistant/sandbox/attachments`、`GET /api/assistant/sandbox/attachments?key=...`：
  上傳或讀取 Sandbox session 的圖片附件；bytes 存 NAS，D1 保存授權與 expiry metadata。
- `PATCH /api/assistant/config`：儲存小香目前使用的模型。
- `PATCH /api/assistant/tools/:key`：更新 tool 的啟用、開發中或停用狀態。
- `POST /api/assistant/prompts`：建立並啟用新的 prompt revision。
- `POST /api/assistant/sandbox/run`：依指定模型、prompt revision 與 tool 執行一次測試。
- `GET /api/assistant/line/config`：LINE channel 狀態、Webhook URL、憑證是否已設定與對話清單；不回傳 credential 原值。
- `PATCH /api/assistant/line/config`：儲存 Channel ID、Channel Secret、Channel Access Token、顯示名稱與 channel 開關。
- `POST /api/assistant/line/groups`、`PATCH /api/assistant/line/groups/:id`：新增或授權對話。
- `POST /api/webhooks/line`：LINE 官方 webhook 入口。

上述後台路由需要已登入且具備對應的 `assistant:*` 權限；目前只有系統管理者預設擁有這些權限。LINE webhook 是 LINE 官方呼叫的公開入口，使用簽章驗證，不使用登入 cookie。
