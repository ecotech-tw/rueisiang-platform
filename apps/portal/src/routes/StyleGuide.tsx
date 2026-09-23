import { useState } from "react";
import { DateRangePicker } from "../shell/DateRangePicker.js";
import { Icon, type IconName } from "../shell/icons.js";
import { Pager } from "../shell/Pager.js";
import { Switch } from "../shell/Switch.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import {
  Alert,
  Button,
  Dialog,
  Field,
  FilterInput,
  FilterSelect,
  PageHeader,
  PageTabs,
  Panel,
  SelectField,
  StatusBadge,
  TextField,
  WorkflowRunPanel,
} from "../ui/index.js";

const TOKENS = [
  { label: "主要色彩", variable: "--color-brand" },
  { label: "主要色彩容器", variable: "--color-brand-soft" },
  { label: "表面文字", variable: "--color-ink" },
  { label: "次要文字", variable: "--color-muted" },
  { label: "外框線", variable: "--color-line" },
  { label: "表面", variable: "--color-paper" },
  { label: "成功", variable: "--color-ok" },
  { label: "警告", variable: "--color-warn" },
  { label: "資訊", variable: "--color-info" },
];

const ICONS: IconName[] = ["analytics", "people", "payments", "calendar", "search", "edit", "check", "info", "tune", "external"];

export function StyleGuide() {
  usePageTitle("UI 元件樣式指南");
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState({ start: "2026-07-01", end: "2026-07-31" });
  const [page, setPage] = useState(3);
  const [message, setMessage] = useState("按下按鈕測試共用元件的互動狀態。");
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = () => setDialogOpen(false);

  return (
    <div className="page style-guide">
      <PageHeader
        title="UI 元件樣式指南"
        description="RUEI SIANG Portal 的 Material 3 tokens、共用元件與互動狀態。之後各 page 應從 src/ui 以 props 組合，而不是自行拼 class。"
        actions={<Button icon="bookmark" variant="secondary" onClick={() => setMessage("這個頁面本身也是 UI layer 的使用範例。")}>使用規則</Button>}
      />

      <Alert tone="info">目前這一頁只需要登入，不會出現在一般 sidebar；可直接開啟 <code>/style-guide</code> 檢查元件。</Alert>

      <Panel title="設計原則" description="語意化元件 class 集中在 components.css，色彩與圓角 token 集中在 styles.css。">
        <div className="style-guide-principles">
          <div><strong>先定義 Props</strong><span>Page 傳入 variant、tone、label、disabled 等語意參數。</span></div>
          <div><strong>Material 3</strong><span>primary container、state layer、focus ring 與安靜的圓角層級。</span></div>
          <div><strong>預設可存取</strong><span>保留原生 input、button、switch 的鍵盤與螢幕閱讀器語意。</span></div>
        </div>
      </Panel>

      <Panel title="色彩 tokens" description="不要在 page 寫死色碼；新增顏色先加到 styles.css 的 @theme。">
        <div className="style-guide-token-grid">
          {TOKENS.map((token) => (
            <div className="style-guide-token" key={token.variable}>
              <span className="style-guide-swatch" style={{ background: `var(${token.variable})` }} />
              <span><strong>{token.label}</strong><code>{token.variable}</code></span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="字體與表面">
        <div className="style-guide-type-grid">
          <div>
            <p className="style-guide-eyebrow">頁面標題 / 24px</p>
            <h1 className="style-guide-display">營運資料，一眼看懂</h1>
            <p className="muted">說明文字使用 on-surface-variant，讓主要資料保有優先層級。</p>
          </div>
          <div className="style-guide-surface-stack">
            <div className="style-guide-surface-sample"><strong>表面 / paper</strong><span>Panel 14px + shadow-panel</span></div>
            <div className="style-guide-surface-sample muted"><strong>畫布</strong><span>頁面背景與次要區塊</span></div>
          </div>
        </div>
      </Panel>

      <Panel title="按鈕與狀態" description="Button 以 variant 控制視覺與語意；StatusBadge 以 tone 控制狀態色。">
        <div className="style-guide-stack">
          <div className="style-guide-row">
            <Button icon="plus" onClick={() => setMessage("已觸發主要按鈕")}>主要動作</Button>
            <Button variant="secondary" icon="edit">次要動作</Button>
            <Button variant="danger" icon="trash">危險動作</Button>
            <Button variant="link">文字操作</Button>
            <Button variant="icon" icon="search" aria-label="搜尋" />
            <Button disabled>停用</Button>
            <Button loading loadingLabel="同步中…">同步資料</Button>
            <Button variant="chip" selected icon="check">已選取</Button>
            <Button variant="chip-action" icon="bookmark">新增視圖</Button>
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>預覽 Dialog</Button>
          </div>
          <div className="style-guide-row">
            <StatusBadge tone="success">已完成</StatusBadge>
            <StatusBadge tone="info">同步中</StatusBadge>
            <StatusBadge tone="warning">等待處理</StatusBadge>
            <StatusBadge tone="danger">失敗</StatusBadge>
            <StatusBadge>未設定</StatusBadge>
          </div>
          <p className="form-hint">互動回饋：{message}</p>
        </div>
      </Panel>

      <Panel title="對話框與工作狀態" description="Dialog 統一遮罩、標題列、關閉行為與 actions；WorkflowRunPanel 統一 GitHub Actions 的狀態與步驟。">
        <WorkflowRunPanel
          tracking
          latest={{ status: "in_progress", conclusion: null }}
          steps={[
            { name: "取得報表", status: "completed", conclusion: "success" },
            { name: "整理並上傳", status: "in_progress", conclusion: null },
            { name: "完成", status: "queued", conclusion: null },
          ]}
        />
      </Panel>

      <Panel title="表單與控制項" description="Field、TextField、SelectField 與既有 DateRangePicker / Switch 都可用 props 組合。">
        <div className="field-grid">
          <TextField label="名稱" required defaultValue="Ruei Siang" hint="欄位下方的輔助說明。" />
          <SelectField
            label="狀態"
            defaultValue="active"
            options={[{ label: "啟用", value: "active" }, { label: "停用", value: "disabled" }]}
          />
          <Field label="錯誤狀態" error="請輸入有效的資料。">
            <input defaultValue="格式錯誤" aria-invalid="true" />
          </Field>
        </div>
        <div className="style-guide-control-row">
          <div className="style-guide-switch-copy"><Switch checked={enabled} onChange={setEnabled} label="即時同步" /><span><strong>即時同步</strong><small>{enabled ? "目前開啟" : "目前關閉"}</small></span></div>
          <div className="field"><span>對帳區間</span><DateRangePicker start={range.start} end={range.end} onChange={setRange} /></div>
        </div>
      </Panel>

      <Panel
        title="表格工具列"
        description="搜尋與篩選緊貼在面板標題下方，用自己的下緣分隔線跟資料分成兩個區塊。"
      >
        {/*
          * 工具列要單獨放一個 Panel，因為它靠 margin-top: -4px 貼住 panel-head、
          * 靠左右的負 margin 撐到面板邊緣。放在別的內容後面會往上疊 4px。
          */}
        <div className="admin-form toolbar">
          <FilterInput label="搜尋" type="search" defaultValue="客戶" placeholder="搜尋關鍵字" />
          <FilterSelect
            label="狀態"
            defaultValue="all"
            options={[{ value: "all", label: "全部狀態" }, { value: "active", label: "正常" }]}
          />
        </div>
      </Panel>

      <Panel title="回饋" description="錯誤留在原地；成功或資訊可以用 Alert 做明確但不打斷的回饋。">
        <div className="style-guide-stack">
          <Alert tone="success">報表已成功整理並上傳。</Alert>
          <Alert tone="warning">目前仍有一個工作在等待執行。</Alert>
          <Alert tone="danger">無法連線到服務，請稍後再試。</Alert>
        </div>
      </Panel>

      <Panel title="分頁標籤" description="同一個功能底下平行子頁面的切換列。內凹底槽 ＋ 浮起的選中卡，每一段都是 icon 配文字。">
        <PageTabs label="範例分頁" tabs={[
          { label: "出金表", to: "/style-guide", icon: "payments" as const },
          { label: "商品銷售", to: "/style-guide/demo-a", icon: "report" as const },
          { label: "官網對帳單", to: "/style-guide/demo-b", icon: "globe" as const },
        ]} />
      </Panel>

      <Panel title="資料表與分頁">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>項目</th><th>狀態</th><th className="numeric">數量</th><th>操作</th></tr></thead>
            <tbody>
              <tr><td className="cell-strong">蝦皮銷售報表</td><td><StatusBadge tone="success">已完成</StatusBadge></td><td className="numeric">1,558</td><td><Button variant="icon" icon="external" aria-label="開啟報表" /></td></tr>
              <tr><td className="cell-strong">出金表</td><td><StatusBadge tone="warning">處理中</StatusBadge></td><td className="numeric">42</td><td><Button variant="icon" icon="eye" aria-label="查看狀態" /></td></tr>
            </tbody>
          </table>
        </div>
        <Pager page={page} pageSize={20} pageSizes={[10, 20, 50]} totalPages={8} totalLabel="共 158 筆" onPage={setPage} onPageSize={() => {}} />
        <div className="empty-state">沒有資料時使用 empty-state，保留清楚的下一步說明。</div>
      </Panel>

      <Panel title="圖示系統" description="沿用 shell/icons.tsx 的 24px、currentColor、線性 SVG。">
        <div className="style-guide-icon-grid">
          {ICONS.map((name) => <div className="style-guide-icon" key={name}><Icon name={name} /><code>{name}</code></div>)}
        </div>
      </Panel>

      {dialogOpen ? (
        <Dialog
          title="共用 Dialog 預覽"
          onClose={closeDialog}
          actions={<Button type="button" onClick={closeDialog}>完成</Button>}
        >
          <p>頁面只提供內容與 actions，遮罩、標題列、ARIA 與關閉按鈕由 Dialog 統一處理。</p>
        </Dialog>
      ) : null}
    </div>
  );
}
