import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
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
      <header className="page-head">
        <h1>蝦皮報表設定</h1>
        <p className="muted">設定蝦皮銷售報表整理後要上傳的 Google Drive 資料夾。使用者上傳 Excel 後，GitHub Actions 會把新檔放到這裡。</p>
      </header>
      <section className="panel">
        <form className="admin-form" onSubmit={(event) => { event.preventDefault(); save.mutate({ driveFolderUrl: url, driveFolderName: name }); }}>
          <label>Google Drive 資料夾連結<input className="cell-input wide" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://drive.google.com/drive/folders/..." /></label>
          <label>顯示名稱<input className="cell-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="蝦皮銷售報表" /></label>
          <div className="form-actions"><button type="submit" className="primary-button" disabled={save.isPending}>{save.isPending ? "儲存中…" : "儲存設定"}</button>{save.isSuccess ? <span className="form-hint">已儲存。</span> : null}</div>
          {save.error ? <p className="form-error" role="alert">{save.error.message}</p> : null}
        </form>
      </section>
    </div>
  );
}
