import { useMemo, useState } from "react";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import type { ProductCategory, Zone } from "./api.js";

interface CatalogItem { id: string; sku: string; name: string; source: string; inWarehouse: boolean; }

async function readError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  throw new Error(body?.message ?? body?.error ?? `操作失敗（${response.status}）。`);
}

export function EnrollItemDialog({ categories, zones, onClose, onSuccess }: { categories: ProductCategory[]; zones: Zone[]; onClose: () => void; onSuccess: () => void }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [zoneId, setZoneId] = useState("");
  const [shelfLevel, setShelfLevel] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [unit, setUnit] = useState("件");
  const [minStock, setMinStock] = useState("5");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const zone = zones.find((candidate) => candidate.id === zoneId);
  const selected = catalog.find((item) => item.id === selectedId);

  useMemo(() => {
    void fetch("/api/items/catalog", { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) await readError(response);
      const data = await response.json() as { items: CatalogItem[] };
      setCatalog(data.items.filter((item) => !item.inWarehouse && item.source !== "wms"));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "無法載入品項主檔。"));
  }, []);

  const options = catalog.filter((item) => {
    const term = search.trim().toLowerCase();
    return !term || `${item.sku} ${item.name}`.toLowerCase().includes(term);
  }).slice(0, 30);

  async function submit() {
    if (!selected) { setError("請先選擇一個品項。"); return; }
    setPending(true); setError(null);
    try {
      const response = await fetch(`/api/items/catalog/${selected.id}/warehouse`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wmsCategoryId: categoryId || null, zoneId: zoneId || null, shelfLevel: shelfLevel || null, quantity: Math.max(0, Math.round(Number(quantity) || 0)), unit: unit.trim() || "件", minStock: Math.max(0, Math.round(Number(minStock) || 0)) }),
      });
      if (!response.ok) await readError(response);
      onSuccess(); onClose();
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : "納入倉儲失敗。"); }
    finally { setPending(false); }
  }

  return <Dialog title="從品項主檔納入倉儲" onClose={onClose} closeDisabled={pending} formProps={{ onSubmit: (event) => { event.preventDefault(); void submit(); } }} actions={<><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button type="submit" loading={pending}>納入倉儲</Button></>}>
    <TextField label="搜尋品項" placeholder="搜尋 SKU、商品名稱" value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
    <div className="combobox-options" role="listbox" aria-label="品項選擇">
      {options.map((item) => <button type="button" role="option" aria-selected={item.id === selectedId} className={`combobox-option${item.id === selectedId ? " selected" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}><strong>{item.name}</strong><span>{item.sku}</span></button>)}
      {!options.length ? <p className="muted">沒有可納入的品項。</p> : null}
    </div>
    {selected ? <p className="field-static">已選擇：{selected.name}（{selected.sku}）</p> : null}
    <SelectField label="倉儲分類" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} options={[{ label: "未分類", value: "" }, ...categories.map((item) => ({ label: item.name, value: item.id }))]} />
    <div className="field-grid"><SelectField label="倉位" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setShelfLevel(""); }} options={[{ label: "未指定倉位", value: "" }, ...zones.map((item) => ({ label: `${item.code} ${item.name}`, value: item.id }))]} /><SelectField label="層架" value={shelfLevel} disabled={!zone} onChange={(event) => setShelfLevel(event.target.value)} options={[{ label: zone ? "不指定層架" : "請先選倉位", value: "" }, ...(zone?.shelfLevels ?? []).map((item) => ({ label: item.name, value: item.id }))]} /></div>
    <div className="field-grid trio"><TextField label="初始數量" type="number" min={0} value={quantity} onChange={(event) => setQuantity(event.target.value)} /><TextField label="單位" value={unit} onChange={(event) => setUnit(event.target.value)} /><TextField label="安全庫存" type="number" min={0} value={minStock} onChange={(event) => setMinStock(event.target.value)} /></div>
    {error ? <Alert tone="danger">{error}</Alert> : null}
  </Dialog>;
}
