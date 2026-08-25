import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, TextField } from "../../ui/index.js";
import { useSaveShopeeSalesSettings, useShopeeSalesSettings } from "./api.js";

export function ShopeeSalesSettings() {
  usePageTitle("蝦皮報表設定");
  const query = useShopeeSalesSettings();
  const save = useSaveShopeeSalesSettings();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!query.data || loaded) return;
    setUrl(query.data.settings.driveFolderUrl);
    setName(query.data.settings.driveFolderName);
    setLoaded(true);
  }, [query.data, loaded]);

  if (query.isPending) return <div className="boot">載入中…</div>;

  return (
    <div className="page">
      <PageHeader
        title="蝦皮報表設定"
        description="設定蝦皮銷售報表整理後要上傳的 Google Drive 資料夾。使用者上傳 Excel 後，GitHub Actions 會把新檔放到這裡。"
      />
      <Panel>
        <form className="admin-form" onSubmit={(event) => { event.preventDefault(); save.mutate({ driveFolderUrl: url, driveFolderName: name }); }}>
          <TextField label="Google Drive 資料夾連結" inputClassName="cell-input wide" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://drive.google.com/drive/folders/..." />
          <TextField label="顯示名稱" inputClassName="cell-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="蝦皮銷售報表" />
          <div className="form-actions"><Button type="submit" disabled={save.isPending}>{save.isPending ? "儲存中…" : "儲存設定"}</Button>{save.isSuccess ? <span className="form-hint">已儲存。</span> : null}</div>
          {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
        </form>
      </Panel>
    </div>
  );
}
