import { useMemo, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, FilterInput, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
import {
  useReportPayout,
  useReportSales,
  useReportScopes,
  type ReportRow,
} from "./api.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (index ?? 1) - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function monthEnd(month: string): string {
  const [year, index] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, index ?? 0, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

function text(row: ReportRow, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function amount(row: ReportRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function money(value: number): string {
  return value.toLocaleString("zh-TW");
}

/** 主表點開的那一格。reportMonth 是空字串代表「整段區間的這個據點」。 */
interface Drill {
  reportMonth: string;
  scopeId: string;
  label: string;
}

export function Reports() {
  usePageTitle("報表檢視");
  const scopes = useReportScopes();
  // 預設看最近三個月的全公司；當月的資料通常還沒匯入，但空月份比預設看不到今年更好懂。
  const [startMonth, setStartMonth] = useState(() => shiftMonth(currentMonth(), -2));
  const [endMonth, setEndMonth] = useState(currentMonth);
  const [scopeId, setScopeId] = useState("");
  const [overviewBy, setOverviewBy] = useState<"month" | "scope">("month");
  const [detailBy, setDetailBy] = useState<"product" | "category">("product");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);

  const rangeError = !MONTH.test(startMonth) || !MONTH.test(endMonth)
    ? "請選擇起訖月份。"
    : startMonth > endMonth ? "起月不能晚於迄月。" : "";
  const enabled = !rangeError;
  const range = { startDate: monthStart(startMonth), endDate: monthEnd(endMonth), scopeId };

  const overviewGroups = overviewBy === "month" ? ["month", "scope"] : ["scope"];
  const overviewSales = useReportSales({ ...range, groupBy: overviewGroups }, enabled);
  const overviewPayout = useReportPayout({ ...range, groupBy: overviewGroups }, enabled);

  // 點開某一格之後，商品明細只看那一格；沒點就是工具列選的整段區間。
  const detailRange = drill
    ? {
      startDate: drill.reportMonth ? monthStart(drill.reportMonth) : range.startDate,
      endDate: drill.reportMonth ? monthEnd(drill.reportMonth) : range.endDate,
      scopeId: drill.scopeId,
    }
    : range;
  const detail = useReportSales(
    { ...detailRange, groupBy: detailBy === "product" ? ["sku", "product", "category"] : ["category"] },
    enabled,
  );

  // 出金才有日粒度，但整間公司逐日看沒有意義（各通路入帳日不同），所以只在單店時提供。
  const daily = useReportPayout({ ...range, groupBy: ["day"] }, enabled && Boolean(scopeId));

  /** 銷售只有月粒度，所以兩份資料只能在「月 × 據點」這個軸上併起來看。 */
  const overview = useMemo(() => {
    const merged = new Map<string, {
      reportMonth: string;
      scopeId: string;
      scopeName: string;
      netQuantity: number;
      salesAmount: number;
      payoutAmount: number;
    }>();
    const entry = (row: ReportRow) => {
      const reportMonth = text(row, "reportMonth");
      const rowScopeId = text(row, "scopeId");
      const key = `${reportMonth}|${rowScopeId}`;
      const existing = merged.get(key);
      if (existing) return existing;
      const created = {
        reportMonth,
        scopeId: rowScopeId,
        scopeName: text(row, "scopeName") || rowScopeId,
        netQuantity: 0,
        salesAmount: 0,
        payoutAmount: 0,
      };
      merged.set(key, created);
      return created;
    };
    for (const row of overviewSales.data?.rows ?? []) {
      const item = entry(row);
      item.netQuantity += amount(row, "netQuantity");
      item.salesAmount += amount(row, "salesAmount");
    }
    for (const row of overviewPayout.data?.rows ?? []) {
      entry(row).payoutAmount += amount(row, "payoutAmount");
    }
    const rows = [...merged.values()];
    // 依據點時售額由高到低，排行一目了然；依月份時先照月份新到舊，同月再照店名。
    return overviewBy === "scope"
      ? rows.sort((a, b) => b.salesAmount - a.salesAmount)
      : rows.sort((a, b) => (a.reportMonth === b.reportMonth
        ? a.scopeName.localeCompare(b.scopeName, "zh-TW")
        : b.reportMonth.localeCompare(a.reportMonth)));
  }, [overviewSales.data, overviewPayout.data, overviewBy]);

  const detailRows = detail.data?.rows ?? [];
  const categories = useMemo(
    () => [...new Set(detailRows.map((row) => text(row, "category")).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-TW")),
    [detailRows],
  );
  const visibleDetail = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase();
    return detailRows.filter((row) => {
      if (category && text(row, "category") !== category) return false;
      if (!needle) return true;
      return `${text(row, "sku")} ${text(row, "productName")}`.toLocaleLowerCase().includes(needle);
    });
  }, [detailRows, keyword, category]);

  const loading = overviewSales.isPending || overviewPayout.isPending;
  const failure = overviewSales.error ?? overviewPayout.error ?? detail.error ?? daily.error;
  const notice = overviewSales.data?.status !== "ok" ? overviewSales.data?.message : undefined;

  /** 改了區間或據點之後，舊的下鑽可能已經不在範圍裡，留著只會顯示對不上的數字。 */
  function reset<T>(apply: (value: T) => void) {
    return (value: T) => {
      setDrill(null);
      apply(value);
    };
  }

  return (
    <div className="page fills">
      <PageHeader
        title="報表檢視"
        description="已匯入 D1 的商品銷售與出金資料。銷售只有月粒度，出金另有逐日明細。"
      />

      <Panel>
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <span className="inline-label">月份區間</span>
          <input
            className="text-input"
            type="month"
            value={startMonth}
            onChange={(event) => reset(setStartMonth)(event.target.value)}
            aria-label="起始月份"
          />
          <span className="inline-label">～</span>
          <input
            className="text-input"
            type="month"
            value={endMonth}
            onChange={(event) => reset(setEndMonth)(event.target.value)}
            aria-label="結束月份"
          />
          <FilterSelect
            label="據點"
            value={scopeId}
            onChange={(event) => reset(setScopeId)(event.target.value)}
            options={[
              { label: "全公司", value: "" },
              ...(scopes.data?.scopes ?? []).map((scope) => ({ label: scope.name, value: scope.id })),
            ]}
          />
        </form>
      </Panel>

      {rangeError ? <Alert tone="danger">{rangeError}</Alert> : null}
      {failure ? <Alert tone="danger">{failure.message}</Alert> : null}
      {notice ? <Alert tone="warning">{notice}</Alert> : null}

      <div className="stat-row">
        <div className="stat"><span>售額總計</span><strong>{money(overviewSales.data?.totals.salesAmount ?? 0)}</strong></div>
        <div className="stat"><span>淨銷售數量</span><strong>{money(overviewSales.data?.totals.netQuantity ?? 0)}</strong></div>
        <div className="stat"><span>出金總額</span><strong>{money(overviewPayout.data?.totals.payoutAmount ?? 0)}</strong></div>
      </div>

      <Panel
        title={overviewBy === "month" ? "各月各據點" : "各據點小計"}
        actions={
          <FilterSelect
            label="彙總方式"
            value={overviewBy}
            onChange={(event) => reset(setOverviewBy)(event.target.value as "month" | "scope")}
            options={[{ label: "依月份", value: "month" }, { label: "依據點", value: "scope" }]}
          />
        }
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {overviewBy === "month" ? <th>月份</th> : null}
                <th>據點</th>
                <th className="numeric">淨銷售數量</th>
                <th className="numeric">售額總計</th>
                <th className="numeric">出金金額</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.map((row) => {
                const label = row.reportMonth ? `${row.reportMonth} · ${row.scopeName}` : row.scopeName;
                const open = drill?.reportMonth === row.reportMonth && drill?.scopeId === row.scopeId;
                return (
                  <tr key={`${row.reportMonth}|${row.scopeId}`}>
                    {overviewBy === "month" ? <td className="whitespace-nowrap">{row.reportMonth}</td> : null}
                    <td>{row.scopeName}</td>
                    <td className="numeric">{money(row.netQuantity)}</td>
                    <td className="numeric">{money(row.salesAmount)}</td>
                    <td className="numeric">{money(row.payoutAmount)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => setDrill(open
                          ? null
                          : { reportMonth: row.reportMonth, scopeId: row.scopeId, label })}
                      >
                        {open ? "取消" : "明細"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && !overview.length ? <p className="muted table-note">這段區間還沒有匯入的資料。</p> : null}
      </Panel>

      <Panel
        title="商品明細"
        description={drill ? `只顯示 ${drill.label}` : undefined}
        actions={
          <div className="toolbar">
            {drill ? <Button variant="secondary" onClick={() => setDrill(null)}>看全部</Button> : null}
            <FilterSelect
              label="檢視方式"
              value={detailBy}
              onChange={(event) => { setDetailBy(event.target.value as "product" | "category"); setCategory(""); }}
              options={[{ label: "依商品", value: "product" }, { label: "依分類", value: "category" }]}
            />
            {detailBy === "product" ? (
              <>
                <FilterSelect
                  label="分類"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  options={[{ label: "全部分類", value: "" }, ...categories.map((item) => ({ label: item, value: item }))]}
                />
                <FilterInput
                  label="搜尋 SKU 或商品名稱"
                  placeholder="搜尋 SKU 或商品名稱"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </>
            ) : null}
          </div>
        }
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {detailBy === "product" ? <th>SKU</th> : null}
                {detailBy === "product" ? <th>商品名稱</th> : null}
                <th>分類</th>
                <th className="numeric">銷售數量</th>
                <th className="numeric">退回數量</th>
                <th className="numeric">淨銷售數量</th>
                <th className="numeric">售額總計</th>
              </tr>
            </thead>
            <tbody>
              {visibleDetail.map((row) => (
                <tr key={detailBy === "product" ? `${text(row, "sku")}|${text(row, "productName")}` : text(row, "category")}>
                  {detailBy === "product" ? <td className="cell-sub whitespace-nowrap">{text(row, "sku")}</td> : null}
                  {detailBy === "product" ? <td>{text(row, "productName")}</td> : null}
                  <td>{text(row, "category")}</td>
                  <td className="numeric">{money(amount(row, "grossQuantity"))}</td>
                  <td className="numeric">{money(amount(row, "returnQuantity"))}</td>
                  <td className="numeric">{money(amount(row, "netQuantity"))}</td>
                  <td className="numeric">{money(amount(row, "salesAmount"))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!detail.isPending && !visibleDetail.length ? (
          <p className="muted table-note">
            {detailRows.length ? "沒有符合搜尋條件的商品。" : "這段區間還沒有匯入的商品銷售資料。"}
          </p>
        ) : null}
      </Panel>

      {scopeId ? (
        <Panel title="出金逐日">
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>日期</th><th className="numeric">出金金額</th></tr></thead>
              <tbody>
                {(daily.data?.rows ?? []).map((row) => (
                  <tr key={text(row, "businessDate")}>
                    <td className="whitespace-nowrap">{text(row, "businessDate")}</td>
                    <td className="numeric">{money(amount(row, "payoutAmount"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!daily.isPending && !(daily.data?.rows ?? []).length ? (
            <p className="muted table-note">這段區間這個據點還沒有匯入的出金資料。</p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
