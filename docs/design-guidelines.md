# Rueisiang 平台 UI Design Guideline

> 文件類型：系統現況與共同規格。程式碼是實作的唯一來源；本文件定義共用邊界、視覺契約與新增 UI 時的判斷規則。

## 適用範圍

這份規格適用於：

- `apps/portal`：平台管理站，包含 `/hr` HRIS 管理介面。
- `apps/hr`：員工 HR 站，包含打卡、申請與個人資訊。
- 其他沿用平台 Material 3 視覺的前端頁面。

所有涉及 UI 的 agent，在新增或修改頁面、元件、CSS 前先讀本文件與 `better-ui` skill。若既有元件能承載需求，不得在 route 裡另做一份外觀相同的 markup 或 CSS。

## 盤點結論

### 跨 app 應共用的 primitive

第一階段已完成抽離：

| 類別 | 共用來源 | app 端做法 |
|---|---|---|
| UI primitive | `packages/ui/src/` | `apps/portal/src/ui/`、`apps/hr/src/ui/` 保留相容性 re-export，不再放實作 |
| 對話框 context | `packages/ui/src/dialog-context.ts` | 兩個 app 只 re-export type／context |
| icon registry | `packages/ui/src/icons.tsx` | 兩個 app 的 `shell/icons.tsx` 只 re-export；portal 原有 icon 名稱全部保留 |
| HRIS composite | `SegmentedControl`、`FilterToolbar`、`EmptyState`、`DataTable` | HR route 直接從 app 的 `ui/index.ts` 組合，實作仍只有一份 |
| token | `packages/ui/theme.css` | 兩個 app 的 styles 入口只 import 這份；shell／domain CSS 仍保留 app-specific layer |
| primitive CSS | `packages/ui/components.css` | table、status、alert、empty、dialog、panel、field、button、filter、pager、tooltip 的 base styles 只維護一份；shell／domain modifier 留在 app |

已抽出的 primitive 包含 `Button`、`Dialog`、`ConfirmDialog`、`DropdownSelect`、`FilterInput`、`FilterSelect`、`SearchFilterInput`、`Pager`、`Alert`、`StatusBadge`、`Field`、`TextField`、`SelectField`、`Panel`、`PageHeader`、`Tooltip`。`Dialog` 預設 portal 到 `body`；需要保留在沉浸式全頁容器內的例外，明確使用 `portal={false}`（目前打卡確認框）。

上述已抽出的 app `ui/*.tsx` 檔案是刻意保留的相容性入口，**不要在那裡重新加入實作**。新增共用 primitive 應先放 `packages/ui`，再由兩個 app re-export。

### HRIS composite 的抽離狀態

已完成的 pattern 直接使用共用元件；尚未抽離的項目保留 contract，避免各頁繼續分叉：

| 候選元件 | 現況盤點 | 規範 |
|---|---|---|
| `SegmentedControl` | 原有 4 個 `segmented-control` 已集中到 `packages/ui`，並由特休、申請類型、勞健保狀態、級距種類使用 | 用 `options`、`value`、`onChange`、`aria-label` 表達；selected／`aria-pressed` 不可由每頁自行拼 class |
| `FilterToolbar` | 11 個 HR route 已改用 `FilterToolbar`；`admin-form toolbar` 只留給非 form 的內嵌欄位群 | 保留表單語意；搜尋、篩選、清除動作與 responsive 排列集中管理 |
| `StatusBadge` 的所有狀態呈現 | 上述 6 個 HR route 已改用 `StatusBadge`；domain status 的 label／tone mapping 仍留在 route | 一律使用 `StatusBadge`。禁止新增裸 `.status` 或 `.status-badge`；`SupportWorkers.tsx` 的錯誤 class 已移除 |
| `EmptyState` | 17 個 HRIS 空資料訊息已改用 `EmptyState`；仍保留語意不同的 `muted table-note` | 列表沒有資料用 `EmptyState`；載入中用 skeleton／loading；錯誤用 `Alert`，三者不要混成一個狀態 |
| `EmployeeFilterBar` | 敘薪與勞健保頁重複同一組員工搜尋、帳號狀態篩選、分頁 query 組合 | 兩頁的業務資料不同，但篩選 UI 與 query state 可共用；共用元件不得承擔薪資或保險規則 |
| `DataTable` 基礎外框 | HRIS 的一般資料表已統一使用 `DataTable`；wrapper、table、status／alert／empty 的基礎 CSS 位於 `packages/ui/components.css`；共享 dialog、panel、field、button、tooltip 的 base style 也集中在同一份 CSS；特殊的選取列、手機工具列仍由 route 保留 | `DataTable` 只負責 `.table-scroll`／`.data-table` 外框與 modifier class，不負責欄位、排序、分頁或資料渲染；不要為不同欄位做一個過度通用的資料渲染器，只有排序、分頁、選取等行為穩定重複時才抽小元件 |

這些數字是用目前 `apps/portal/src/routes/hr` 與 `apps/hr/src/routes` 的 source 盤點所得；新增頁面後若數字改變，應更新本節的**結構性結論**，不要把每次使用次數當成另一份手工清單。

## 元件使用契約

### 元件來源

| 需求 | 必須使用 |
|---|---|
| 一般動作、危險動作、圖示動作、loading、chip | `packages/ui` 的 `Button`，用 `variant` 表達語意 |
| 對話框、確認、編輯表單 | `packages/ui` 的 `Dialog`；不要在 route 自己寫 backdrop、`role="dialog"` 或關閉動畫 |
| 單選、多選、搜尋選單 | `packages/ui` 的 `DropdownSelect` 或 `SelectField` |
| 搜尋與篩選 toolbar | `FilterToolbar` 搭配 `FilterInput`、`FilterSelect`、`SearchFilterInput` |
| 分頁導覽與每頁筆數 | `Pager`；頁碼、筆數與 query state 仍由 route 管理 |
| 欄位 label、必填、hint、error | `Field`、`TextField`、`SelectField` |
| 成功／資訊／警告／錯誤 | `StatusBadge` 或 `Alert`；狀態 badge 不用裸 `.status` |
| 頁面標題、卡片 surface | `PageHeader`、`Panel`；不要在 `Panel` 裡重複手寫 `.panel-head`，能用 props 就用 props |
| 補充提示 | `Tooltip`；不要使用原生 `title` |
| icon | `packages/ui/src/icons.tsx` 的共用 `Icon` registry，SVG 使用 `currentColor`；不要引入 icon font 或單頁 SVG 資產 |
| table wrapper | `DataTable`；欄位與 domain row 仍由 route 負責 | 不要在 route 新增裸 `.table-scroll` + `.data-table`；特殊 table 用 `className`／`containerClassName` modifier，保留可讀的 domain markup |

`packages/ui` 是共用元件的唯一實作來源；`apps/portal/src/ui` 與 `apps/hr/src/ui` 只是相容性 re-export。不可只在其中一個 app 複製修正。

### Button

- `primary`：完成、建立、送出、核准等主要動作。
- `secondary`：取消、返回、次要導覽或不具破壞性的輔助動作。
- `danger`：刪除、撤回、停用等不可逆或高風險動作。
- `icon`：表格列操作或純圖示控制；一定要有 `title` 與 `aria-label`。
- `loading` 時由元件負責 disabled 與 `aria-busy`；不要在 route 另做一顆「處理中」按鈕。
- filter chip 用 `selected`，不要在頁面手寫 `aria-pressed` 與 selected class 的同步邏輯。
- 除非連續操作會被縮放干擾，保留按下 `scale: .96`；停用時才使用 `static`。

### Dialog

- `Dialog` 只接受標題、內容與 actions；遮罩、ARIA、focus／close 行為與退場流程集中在元件。
- 有表單時使用 `formProps`，actions 放在 `actions`；不要讓 footer 跟著可捲動 body 一起捲走。
- 非同步成功後關閉使用 `closeRequestRef`，不要直接卸載造成退場動畫被截斷。
- `role="alertdialog"` 只用於需要使用者確認的高風險動作。

### Form

- label、hint、error 一律由 `Field` contract 提供。
- 一般控制項高度使用 `--size-field`（目前 44px）；並排欄位使用 `.field-grid` 或 `.form-grid`。
- textarea 也要放在 `Field` 內；不能只用 placeholder 代替 label 或錯誤訊息。
- 搜尋、篩選是 toolbar 的控制項，不要把頁面資料編輯欄位與篩選欄位混成同一種 layout。

### Status、loading、empty、error

- 狀態顏色是語意，不是頁面自行挑色：`success`、`info`、`warning`、`danger`、`neutral`。
- 同一個 domain status 的 label／tone mapping 放在 domain module 的單一函式或 map；視覺套用由 `StatusBadge` 完成。
- `Alert tone="danger"` 用於錯誤或需要立即注意的訊息；成功回饋不得只靠動畫或顏色。
- 表格無資料使用 `empty-state`／`EmptyState`；查詢仍在進行使用 `HrSkeleton` 或明確的 loading state；不要在空資料時顯示錯誤訊息。

### Table

所有一般資料表遵守同一個外框：

```tsx
<DataTable className="optional-domain-modifier" containerClassName="optional-container-modifier">
  {/* thead / tbody；欄位與 row 由 route 負責 */}
</DataTable>
```

- 表頭 56px、內文列 52px、文字 14px。
- 欄距 16px，最外側欄距 24px；欄與欄之間不畫直線。
- 列與列之間使用 `--color-soft-line`；hover 使用品牌色 4% state layer。
- 數字欄加 `.numeric`，靠右並使用 tabular numerals。
- sticky header、手機 `data-label`、可點列的鍵盤操作要由 table contract 一起維護。
- 不要為了單一頁面複製 `.data-table`；頁面特殊需求用具名 modifier，例如 `hr-payroll-record-table`，傳給 `DataTable` 的 `className`／`containerClassName`。
- 具備 mobile select-all 或其他 table 外部工具列的特殊頁面，可以保留 route 的外層 layout；真正的 table 仍使用 `DataTable`。

## Visual tokens

token contract 唯一來源是 `packages/ui/theme.css` 的 `@theme`，兩個 app 的 styles 入口只 import 這份，不得建立 app 專屬色票。新增 token 先確認它不是既有語意的別名。

| 用途 | token／規格 |
|---|---|
| 品牌主色 | `--color-brand`；hover／深色文字用 `--color-brand-dark` |
| 選中容器 | `--color-brand-soft` + `--color-brand-dark`，不用高彩度整塊填滿 |
| 文字層級 | `--color-ink`、`--color-muted` |
| surface | `--color-paper`、`--color-canvas` |
| 結構線 | `--color-line`、`--color-soft-line` |
| 語意色 | `--color-ok`、`--color-info`、`--color-warn` 及各自的 `*-soft` |
| 卡片 | `--radius-card`（14px）、`--shadow-panel` |
| 欄位 | `--radius-field`（9px）、`--size-field`（44px） |
| 圓角 | 可點列／chip／nav 用 `999px`；小元件 9–12px；卡片 14px；Dialog 28px |
| 字型 | `--font-sans`；body 14px、line-height 1.5 |

禁止在 route 或元件裡新增品牌 hex、近似中性色、`rgba` 品牌色或第二份 shadow。半透明品牌層使用 `--alpha(var(--color-brand) / n%)`。結構線保留 border；只為製造深度的 border 優先改成透明 layered shadow。

## Motion、icon 與 accessibility

- interactive state 只 transition 會變的 property；不要使用 `transition: all`。
- high-frequency feedback 使用 150ms 以內；目前共用按鈕按下是 `.96`、120ms ease-out。
- Dialog 退場為 180ms；CSS 與 `DIALOG_EXIT_DURATION_MS` 必須同步。
- 進場可分語意區塊、約 100ms stagger；退場使用小幅固定位移，不做整個容器高度動畫。
- 尊重 `prefers-reduced-motion`；動畫不能是唯一狀態訊號。
- icon 預設 24px、線性、`currentColor`；icon stroke 要跟文字權重一致。
- 所有互動元件都有 `:focus-visible`；非互動 tooltip anchor 只在必要欄位加 `tabIndex`。
- Tooltip 使用 fixed positioning、量測後夾住視窗邊界；max-width 280px，允許中文換行，不能 `nowrap`。提示只能補充資訊，不能是觸控使用者唯一能取得的資訊。

### HRIS shell 的例外

HRIS 管理站的 `.hr-system` 有獨立的 liquid-glass shell、sticky header、頁面轉場與 surface；員工站的 `.hr-module-self` 有 mobile bottom navigation 與打卡沉浸頁。這些是兩種不同產品 shell，不要為了「看起來都叫 HR」把 `HrLayout`、打卡地圖、管理排班月曆合成一個巨型元件。

共用的是 primitive、token、icon 與 state contract；shell 的版面與領域元件保持各自清楚的責任。

## Agent 開發檢查表

1. 先找 `packages/ui`、app 的相容性 `ui/`、`shell/` 與 token；有既有元件就直接組合，不在 route 重寫 markup。
2. 新增變體先問：是穩定的語意變體，還是單頁一次性的版面？前者加 prop／共用 class，後者用 page modifier。
3. 同一個 pattern 出現於兩個 app 或三個以上 route，先提取 contract，再決定是否抽到 `packages/ui`。
4. 不新增第二個 `Button`、`Dialog`、`Field`、`StatusBadge`、`Tooltip`、`SegmentedControl`、`FilterToolbar`、`EmptyState` 或 icon registry；app `ui/` 只允許 re-export。
5. 檢查 hover、focus-visible、active、disabled、loading、error、empty、responsive 與 reduced motion；每個狀態都要有非動畫的視覺或文字訊號。
6. UI diff 送 review 時列出使用的共用元件、token、特殊 modifier，以及沒有抽象的理由。
7. 送 review 前至少跑 `pnpm lint`、兩個 app 的 typecheck／build 與相關 tests；`pnpm lint` 會檢查 route table wrapper 與 shared primitive CSS 是否被重複定義。

違反本文件的例外必須在 PR 說明原因；不要以「這頁只用一次」為理由複製已存在的共用 primitive。
