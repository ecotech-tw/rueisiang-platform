import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Icon } from "../../../shell/icons.js";
import { usePageTitle } from "../../../shell/usePageTitle.js";
import { Alert, Button, PageHeader } from "../../../ui/index.js";
import { PayoutTab } from "./PayoutTab.js";
import { SalesTab } from "./SalesTab.js";
import { useReportScopes } from "./api.js";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function nowInTaipei(): Date {
  return new Date(Date.now() + TAIPEI_OFFSET_MS);
}

function monthValue(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function monthEnd(value: string): string {
  const [year = 0, month = 0] = value.split("-").map(Number);
  return `${value}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

function currentMonth(): string {
  return monthValue(nowInTaipei());
}

function periodOptions(latestSalesPeriod?: string | null): Array<{ value: string; label: string }> {
  const now = nowInTaipei();
  const month = monthValue(now);
  const year = String(now.getUTCFullYear());
  const options = [
    { value: month, label: `本月（${month}）` },
    { value: year, label: `今年（${year}）` },
  ];
  for (let offset = 1; offset <= 12; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const value = monthValue(date);
    options.push({ value, label: value });
  }
  for (let offset = 1; offset <= 2; offset += 1) {
    const value = String(now.getUTCFullYear() - offset);
    options.push({ value, label: `${value} 年` });
  }
  if (latestSalesPeriod && !options.some((option) => option.value === latestSalesPeriod)) {
    options.unshift({ value: latestSalesPeriod, label: `最新資料（${latestSalesPeriod}）` });
  }
  return options;
}

function updateParams(
  current: URLSearchParams,
  changes: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function Analytics() {
  usePageTitle("營運統計");
  const [params, setParams] = useSearchParams();
  const scopes = useReportScopes();
  const defaultMonth = currentMonth();
  const periodParam = params.get("period");
  const startDate = params.get("startDate") ?? "";
  const endDate = params.get("endDate") ?? "";
  const productParam = params.get("product") ?? "";
  const [productDraft, setProductDraft] = useState(productParam);
  const custom = Boolean(startDate || endDate);
  const selectedScope = params.get("scopeId") ?? "";
  const scopeType: "company" | "store" = selectedScope ? "store" : "company";
  const tab = params.get("tab") === "sales" ? "sales" : "payout";
  const selectedScopeOption = scopes.data?.scopes.find((scope) => scope.id === selectedScope);
  const latestSalesPeriod = tab === "sales"
    ? selectedScope
      ? selectedScopeOption?.latestSalesPeriod ?? null
      : scopes.data?.latestSalesPeriod ?? null
    : null;
  const period = periodParam ?? (tab === "sales" ? latestSalesPeriod ?? defaultMonth : defaultMonth);
  const dateError = custom && startDate && endDate && startDate > endDate;
  const salesPeriodPending = tab === "sales" && !custom && !periodParam && scopes.isPending;
  const ready = (!custom || Boolean(startDate && endDate && !dateError)) && !salesPeriodPending;
  const query = custom
    ? {
      scopeType,
      ...(selectedScope ? { scopeId: selectedScope } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(tab === "sales" && productParam ? { productQuery: productParam } : {}),
    }
    : {
      scopeType,
      ...(selectedScope ? { scopeId: selectedScope } : {}),
      period,
      ...(tab === "sales" && productParam ? { productQuery: productParam } : {}),
    };
  const scopeLabel = selectedScope
    ? scopes.data?.scopes.find((scope) => scope.id === selectedScope)?.name ?? "指定店別"
    : "公司整體";
  const options = useMemo(
    () => periodOptions(latestSalesPeriod),
    [latestSalesPeriod],
  );

  useEffect(() => {
    if (tab !== "sales" || custom || periodParam || salesPeriodPending || !scopes.data) return;
    const nextPeriod = latestSalesPeriod ?? defaultMonth;
    if (params.get("period") === nextPeriod) return;
    setParams(updateParams(params, { period: nextPeriod }), { replace: true });
  }, [custom, defaultMonth, latestSalesPeriod, params, periodParam, salesPeriodPending, scopes.data, setParams, tab]);

  useEffect(() => {
    setProductDraft(productParam);
  }, [productParam]);

  function setFilter(changes: Record<string, string | null>) {
    setParams(updateParams(params, changes), { replace: true });
  }

  function applyProductFilter() {
    setFilter({ product: productDraft.trim() || null });
  }

  return (
    <div className="page analytics-page">
      <PageHeader
        title="營運統計"
        description="比較商品銷量、通路與出金表現；先看整體，再下鑽到單一店別或商品。"
      />

      <section className="panel analytics-filters" aria-label="報表篩選條件">
        <div className="analytics-filter-heading">
          <span className="analytics-filter-icon"><Icon name="calendar" /></span>
          <div>
            <strong>分析範圍</strong>
            <p>選擇店別與期間；切換分析類型時會保留這裡的條件。</p>
          </div>
          <div className="analytics-tabs" role="tablist" aria-label="統計類型">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "payout"}
              className={tab === "payout" ? "analytics-tab active" : "analytics-tab"}
              onClick={() => setFilter({ tab: "payout" })}
            >
              出金
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "sales"}
              className={tab === "sales" ? "analytics-tab active" : "analytics-tab"}
              onClick={() => setFilter({ tab: "sales" })}
            >
              商品銷售
            </button>
          </div>
        </div>
        <div className="analytics-filter-fields">
          <label className="analytics-filter-field">
            <span>店別</span>
            <select
              value={selectedScope}
              onChange={(event) => setFilter({ scopeId: event.target.value || null })}
              disabled={scopes.isPending}
            >
              <option value="">公司整體</option>
              {(scopes.data?.scopes ?? []).map((scope) => (
                <option key={scope.id} value={scope.id}>{scope.name}</option>
              ))}
            </select>
          </label>
          <label className="analytics-filter-field">
            <span>期間</span>
            <select
              value={custom ? "custom" : period}
              onChange={(event) => {
                if (event.target.value === "custom") {
                  const fallbackStart = startDate || `${defaultMonth}-01`;
                  setFilter({ period: null, startDate: fallbackStart, endDate: endDate || monthEnd(defaultMonth) });
                } else {
                  setFilter({ period: event.target.value, startDate: null, endDate: null });
                }
              }}
            >
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              <option value="custom">自訂日期區間</option>
            </select>
          </label>
          {tab === "sales" ? (
            <div className="analytics-filter-field analytics-product-field">
              <span>商品分析</span>
              <div className="analytics-product-control">
                <input
                  value={productDraft}
                  placeholder="商品名稱或 SKU"
                  aria-label="商品名稱或 SKU"
                  onChange={(event) => setProductDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyProductFilter();
                    }
                  }}
                />
                <Button variant="secondary" icon="search" onClick={applyProductFilter}>查看分析</Button>
              </div>
            </div>
          ) : null}
          {custom ? (
            <>
              <label className="analytics-filter-field analytics-filter-date">
                <span>起日</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setFilter({ period: null, startDate: event.target.value || null })}
                />
              </label>
              <label className="analytics-filter-field analytics-filter-date">
                <span>迄日</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setFilter({ period: null, endDate: event.target.value || null })}
                />
              </label>
            </>
          ) : null}
        </div>
        {dateError ? <Alert tone="danger">起日不能晚於迄日。</Alert> : null}
        {scopes.error ? <Alert tone="danger">{scopes.error.message}</Alert> : null}
      </section>

      <div className="analytics-body" role="tabpanel">
        {tab === "payout" ? (
          <PayoutTab query={query} scopeLabel={scopeLabel} enabled={ready} />
        ) : salesPeriodPending ? (
          <div className="boot">尋找最近已匯入的商品銷售月份…</div>
        ) : (
          <SalesTab
            query={query}
            scopeLabel={scopeLabel}
            enabled={ready}
            productQuery={productParam}
            onClearProduct={() => setFilter({ product: null })}
          />
        )}
      </div>
    </div>
  );
}
