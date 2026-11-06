import { useState } from "react";
import { reportPlatformLabel } from "@rueisiang/db/report-platforms";
import { useSession } from "../../../auth/session.js";
import { usePageTitle } from "../../../shell/usePageTitle.js";
import { Alert, Page, PageHeader, SelectField } from "../../../ui/index.js";
import { ShopeeSales } from "../ShopeeSales.js";
import { MoPlusUpload } from "./MoPlusUpload.js";
import { REPORT_SOURCE_ADAPTERS } from "./report-adapters.js";

export function UploadReports() {
  usePageTitle("上傳報表");
  const { permissions } = useSession();
  const sourcePermissions = {
    shopee: "tools:shopee-sales:run",
    mo_plus: "tools:mo-plus-sales:run",
  } as const;
  const available = REPORT_SOURCE_ADAPTERS
    .filter((adapter) => adapter.inputMode === "upload")
    .filter((adapter) => {
      const permission = sourcePermissions[adapter.sourceType as keyof typeof sourcePermissions];
      return permission ? permissions.has(permission) : false;
    })
    .map((adapter) => ({ value: adapter.sourceType, label: reportPlatformLabel(adapter.sourceType) }));
  const [selected, setSelected] = useState(available[0]?.value ?? "");
  const sourceType = available.some((source) => source.value === selected) ? selected : available[0]?.value ?? "";

  return (
    <Page layout="fills">
      <PageHeader title="上傳報表" description="選擇來源後上傳檔案；各來源使用自己的 parser，解析與 SKU 對應結果會進入共用報表資料。" />
      {!available.length ? <Alert tone="warning">你沒有任何上傳報表的執行權限。</Alert> : null}
      {available.length > 1 ? (
        <div className="max-w-sm">
          <SelectField label="報表來源" value={sourceType} onChange={(event) => setSelected(event.target.value)} options={available} />
        </div>
      ) : null}
      {sourceType === "mo_plus" ? <MoPlusUpload /> : null}
      {sourceType === "shopee" ? <ShopeeSales embedded /> : null}
    </Page>
  );
}
