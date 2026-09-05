import { Combobox } from "@base-ui/react/combobox";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import { Icon } from "../../shell/icons.js";
import type { ProductCategory, Zone } from "./api.js";

interface CatalogItem { id: string; sku: string; name: string; source: string; inWarehouse: boolean; }

async function readError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  throw new Error(body?.message ?? body?.error ?? `操作失敗（${response.status}）。`);
}

function CategoryPicker({ categories, value, onChange, disabled }: { categories: ProductCategory[]; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const selected = categories.find((category) => category.id === value) ?? null;
  return (
    <div className="field">
      <span>倉儲分類</span>
      <Combobox.Root
        items={categories}
        value={selected}
        onValueChange={(category) => onChange(category?.id ?? "")}
        itemToStringLabel={(category) => category?.name ?? ""}
        autoHighlight
        disabled={disabled}
      >
        <Combobox.InputGroup className="combobox-group">
          <Combobox.Input className="combobox-input" placeholder="搜尋或選擇倉儲分類" />
          <Combobox.Clear className="combobox-clear" aria-label="清除倉儲分類"><Icon name="close" /></Combobox.Clear>
          <Combobox.Trigger className="combobox-trigger" aria-label="開啟倉儲分類選單"><Icon name="chevronDown" /></Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到倉儲分類</Combobox.Empty><Combobox.List>{(category: ProductCategory) => <Combobox.Item key={category.id} value={category} className="combobox-item"><span>{category.name}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

export function EnrollItemDialog({ categories, zones, onClose, onSuccess }: { categories: ProductCategory[]; zones: Zone[]; onClose: () => void; onSuccess: () => void }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [zoneId, setZoneId] = useState("");
  const [shelfLevel, setShelfLevel] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [unit, setUnit] = useState("件");
  const [minStock, setMinStock] = useState("5");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const zone = zones.find((candidate) => candidate.id === zoneId);
  const occupiedSkus = new Set(catalog.filter((item) => item.inWarehouse).map((item) => item.sku.trim().toUpperCase()).filter(Boolean));
  const seenSkus = new Set<string>();
  const available = catalog.filter((item) => {
    if (item.inWarehouse) return false;
    const normalizedSku = item.sku.trim().toUpperCase();
    if (normalizedSku && (occupiedSkus.has(normalizedSku) || seenSkus.has(normalizedSku))) return false;
    if (normalizedSku) seenSkus.add(normalizedSku);
    return true;
  });
  useEffect(() => {
    void fetch("/api/items/catalog", { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) await readError(response);
      const data = await response.json() as { items: CatalogItem[] };
      setCatalog(data.items);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "無法載入品項列表。"));
  }, []);

  async function submit() {
    if (!categoryId) { setError("請先選擇倉儲分類。"); return; }
    const placement = { wmsCategoryId: categoryId, zoneId: zoneId || null, shelfLevel: shelfLevel || null, quantity: Math.max(0, Math.round(Number(quantity) || 0)), unit: unit.trim() || "件", minStock: Math.max(0, Math.round(Number(minStock) || 0)) };
    if (!selected) { setError("請先選擇要入庫的品項。"); return; }
    const path = `/api/items/catalog/${selected.id}/warehouse`;
    const body: Record<string, unknown> = placement;
    setPending(true); setError(null);
    try {
      const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) await readError(response);
      void queryClient.invalidateQueries({ queryKey: ["items", "catalog"] });
      onSuccess(); onClose();
    } catch (reason: unknown) { setError(reason instanceof Error ? reason.message : "新增入庫失敗。"); }
    finally { setPending(false); }
  }

  return (
    <Dialog title="新增入庫" titleMeta="選擇既有品項建立倉儲庫存，不會在 WMS 重建品項主檔。" onClose={onClose} closeDisabled={pending} formProps={{ onSubmit: (event) => { event.preventDefault(); void submit(); } }} actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button><Button type="submit" loading={pending} disabled={!selected || !categoryId}>新增入庫</Button></>}>
      <div className="field">
        <span>品項<b aria-hidden="true">必填</b></span>
        <Combobox.Root items={available} value={selected} onValueChange={setSelected} itemToStringLabel={(item) => item ? `${item.sku} ${item.name}` : ""} autoHighlight disabled={pending}>
          <Combobox.InputGroup className="combobox-group">
            <Combobox.Input className="combobox-input" placeholder="搜尋 SKU 或品項名稱" autoFocus />
            <Combobox.Clear className="combobox-clear" aria-label="清除品項"><Icon name="close" /></Combobox.Clear>
            <Combobox.Trigger className="combobox-trigger" aria-label="開啟品項選單"><Icon name="chevronDown" /></Combobox.Trigger>
          </Combobox.InputGroup>
          <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>沒有可新增入庫的品項</Combobox.Empty><Combobox.List>{(item: CatalogItem) => <Combobox.Item key={item.id} value={item} className="combobox-item"><strong>{item.sku || "無 SKU"}</strong><span>{item.name}{item.source === "cyberbiz" ? " · CYBERBIZ" : " · 自訂"}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>
        {selected ? <small>已選擇：{selected.name}（{selected.sku || "無 SKU"}）</small> : <small>只顯示尚未納入倉儲的品項，選取後直接建立庫存資料。</small>}
      </div>
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} disabled={pending} />
      <div className="field-grid"><SelectField label="倉位" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setShelfLevel(""); }} options={[{ label: "未指定倉位", value: "" }, ...zones.map((item) => ({ label: `${item.code} ${item.name}`, value: item.id }))]} disabled={pending} /><SelectField label="層架" value={shelfLevel} disabled={!zone || pending} onChange={(event) => setShelfLevel(event.target.value)} options={[{ label: zone ? "不指定層架" : "請先選倉位", value: "" }, ...(zone?.shelfLevels ?? []).map((item) => ({ label: item.name, value: item.id }))]} /></div>
      <div className="field-grid trio"><TextField label="初始數量" type="number" min={0} value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={pending} /><TextField label="單位" value={unit} onChange={(event) => setUnit(event.target.value)} disabled={pending} /><TextField label="安全庫存" type="number" min={0} value={minStock} onChange={(event) => setMinStock(event.target.value)} disabled={pending} /></div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Dialog>
  );
}
