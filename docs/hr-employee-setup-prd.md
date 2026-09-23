# HR 員工設定 PRD

## 1. 目的與資料模型

HR 員工是既有平台使用者（`users`）的人事延伸；帳號狀態與員工封存狀態分開管理。

```text
users 1 ─── 0..1 hr_employments
```

`hr_employments` 是唯一的員工主檔，也是目前職位的唯一來源：

| 欄位 | 語意 |
|---|---|
| `employee_user_id` | 對應 `users.id`；姓名、Email 與帳號狀態仍以 `users` 為準 |
| `employee_number` | 員工編號；活動員工不可重複 |
| `position` | 目前職位；升遷／調職直接更新此欄位 |
| `supervisor_user_id` | 目前主管，可為 NULL |
| `archived_at` | NULL 表示目前員工；非 NULL 表示員工已封存 |
| `id` | 穩定的 `employmentId`，供薪資、出勤、保險、假勤、排班與稽核歷史使用 |
| `revision` | 一般員工資料異動的競態控制版本 |

升遷、調職不建立任職版本；`hr_compensation_versions` 仍保留自己的敘薪版本控制。封存不物理刪除列，也不刪除任何下游資料。

## 2. 核心決策

1. `users.status` 與 `hr_employments.archived_at` 是兩個獨立狀態。
2. `active` 員工的判斷唯一為 `archived_at IS NULL`，不使用到職日、離職日或帳號狀態推導。
3. `active` 或 `invited` 的 User 可以指派；`disabled` 帳號不能新指派。
4. 指派時同一個原子操作建立員工主檔與 `hr_employment_attendance_settings`，預設出勤方式為一般辦公。
5. 員工編號、職位與主管直接保存於同一筆 `hr_employments`。
6. 封存只改變業務欄位 `archived_at`；`revision` 僅前進作為競態控制，不改寫員工編號、職位、主管、`employmentId` 或下游歷史。
7. 重新啟用已封存員工沿用同一個 `employmentId`，清除 `archived_at` 並由資料庫唯一索引檢查活動員工編號與 User 的唯一性。
8. 帳號停用不等於員工封存；封存也不會停用帳號。

## 3. 範圍

### 包含

- 從既有 User 候選清單指派員工。
- 編輯員工編號與目前職位。
- 設定或清除目前主管。
- 查看、搜尋、排序與分頁員工。
- 封存與重新啟用員工。
- 查看出勤設定、工作範圍與下游歷史入口。
- 將穩定 `employmentId` 傳給薪資、出勤、保險、請假、加班、排班、獎金與稽核模組。

### 不包含

員工基本資料頁不直接編輯：

- 薪資與勞健保版本
- 營運據點／出勤位置指派
- 排班與班別
- 獎金、請假與加班

這些資料由各自的 HR 管理頁維護；它們保留自己的歷史與版本規則。

## 4. 頁面與欄位

```text
HRIS
└─ 員工管理
   ├─ 員工列表
   └─ 員工內頁
```

### 員工列表

- 主要操作為「指派員工」，危險操作為「封存」。
- 搜尋姓名、Email、員工編號與職位。
- 任職狀態分為「目前員工」與「已封存」；判斷只看 `archived_at`。
- 帳號狀態另看 `users.status`，至少顯示全部、啟用中、待啟用與已停用。
- 欄位包含員工編號、姓名、職位、Email、帳號狀態、主管與員工狀態。
- 支援排序、分頁與目前員工／已封存計數；姓名與 Email 不複製到 HR 表單。

### 指派／重新啟用 Dialog

| 欄位 | 必填 | 規則 |
|---|---:|---|
| 使用者 | 是 | 只能選尚未有活動 `hr_employments` 的 `active`／`invited` User |
| 員工編號 | 是 | 1～40 字元；活動員工全平台唯一 |
| 職位 | 是 | 1～100 字元 |
| 出勤方式 | 否 | 未提供時為 `general`；排班與月休另在出勤設定維護 |

重新啟用已封存員工時沿用原列與原 `employmentId`，只清除封存狀態並套用新的員工編號／職位／出勤方式；既有列必須帶目前 `revision`，避免無版本的舊請求覆寫重新啟用資料。

### 員工內頁

- 姓名、Email、帳號狀態來自 `users`。
- 員工編號、職位、主管與 `employmentId` 來自同一筆 `hr_employments`。
- 顯示封存時間與目前出勤設定；已封存員工仍可查閱下游歷史。
- 薪資、保險、假勤、打卡、工作範圍與排班使用相同 `employmentId` 查詢。

## 5. 狀態與異動規則

### 指派

指派須在同一個資料庫 batch 內完成：

1. 建立或重新啟用 `hr_employments`。
2. 建立或更新 `hr_employment_attendance_settings`。
3. 寫入 HR activity event。

任一步失敗都不得留下半套員工資料。唯一索引與 mutation guard 同時防止重複指派及競態寫入。

### 升遷／調職

編輯目前職位只更新 `hr_employments.position`；不新增任職列、不改 `employmentId`，也不自動建立敘薪版本。需要薪資變更時，由敘薪頁建立對應的 `hr_compensation_versions`。

### 封存

封存使用 `archived_at = CURRENT_TIMESTAMP`，並寫入 `employment_archived` activity event。封存操作不得物理刪除：

- `hr_employments` 原列與 `employmentId`
- 員工編號、職位、主管與建立／更新時間
- 出勤、打卡、工作範圍、薪資、保險、假勤、加班、排班、獎金與薪資結算
- `hr_employment_actions` 與共用 activity log

重新啟用不是建立新版本；仍使用同一筆主檔。舊 client 的 `/end` 與 `/withdraw` 路由可相容地映射到封存，但新 UI 使用 `/archive` 語意。

## 6. 主管規則

- 主管必須是另一位 `active` 帳號且有未封存的 `hr_employments`。
- 不可指定自己；可清除主管。
- 主管保存於 `hr_employments.supervisor_user_id`，補打卡與其他申請可把它作為預設審核者。

## 7. 權限

| 操作 | 權限 |
|---|---|
| 查看員工列表與基本資料 | `hr:employee:read` |
| 指派、編輯、封存、重新啟用 | `hr:employee:write` |
| 設定主管 | `hr:employee:write` |
| 出勤方式與位置設定 | `hr:office:write` |
| 薪資、保險與敏感歷史 | 依各模組的獨立權限 |

本人入口只依 session User 查詢活動員工，不接受 query string 覆寫身分；已封存員工不再視為 HRIS 活動員工。

## 8. 失敗狀態與驗收

後端必須明確回報：User 不存在或帳號不可指派、活動 User 已存在、員工編號重複、主管無效、員工已封存或資料在競態中變更。錯誤不得留下成功 activity event 或半套設定。

驗收重點：

- 同一 User 最多一筆未封存 `hr_employments`。
- 同一員工編號最多一筆未封存 `hr_employments`。
- 升遷／調職前後 `employmentId` 不變，且不會多出任職列。
- 封存後資料與所有外鍵歷史仍可查，重新啟用沿用原列。
- 停用帳號與員工封存互不代替。
- 所有活動員工查詢以 `archived_at IS NULL` 為條件。
- 任何下游歷史不得因員工封存而被刪除或改寫。

## 9. UI 要求

沿用 Material 3 與既有元件：列表使用 `.page.fills`／`.panel.grows`、`.data-table` sticky header、compact toolbar 與既有 Dialog。主要操作靠右、危險操作使用 archive 語意；表格列只提供入口，完整編輯在 Dialog 或各自的 HR 管理頁。鍵盤焦點、可及性名稱、錯誤訊息與 Tooltip 必須遵守共用元件規格。
