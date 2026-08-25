# Rueisiang Platform NAS storage gateway

這個服務是 NAS 上的私有媒體儲存邊界。Worker、LINE 與 portal 不直接接觸 NAS
檔案系統，也不把 `/volume1` 絕對路徑或公開檔案網址交給瀏覽器或模型。

## 目錄

目前 NAS 已建立：

```text
/volume1/rueisiang-platform/
├── assistant/
│   └── vision/<chat-id>/
└── wms/
    └── zones/
```

gateway 會依 namespace 與 scope 自動產生物件 key：

```text
assistant/vision/<chat-id>/<yyyy>/<mm>/<uuid>.<ext>
wms/zones/<zone-id>/<yyyy>/<mm>/<uuid>.<ext>
```

## API

`GET /healthz` 只回傳健康狀態，不讀取檔案。

其餘 endpoint 都需要獨立的 `x-storage-token`，不可重用 Codex relay token。

### Upload

```http
POST /v1/objects?namespace=assistant&scope=vision&scopeId=<chat-id>
x-storage-token: <storage-token>
Content-Type: image/jpeg

<raw image bytes>
```

WMS 圖片要加上 `scopeId`：

```text
/v1/objects?namespace=wms&scope=zones&scopeId=<zone-id>
```

回應包含 gateway 產生的 `key`、bytes 大小、MIME type 與 SHA-256 checksum。服務只接受
JPEG、PNG、WebP、GIF，預設單一物件上限為 10 MiB；上限由
`STORAGE_MAX_OBJECT_BYTES` 控制。

### Read / head / delete

三者都使用 upload 回傳的 key：

```text
GET  /v1/objects?key=<url-encoded-key>
HEAD /v1/objects?key=<url-encoded-key>
DELETE /v1/objects?key=<url-encoded-key>
```

key 只接受 gateway 產生的兩種 layout，並拒絕 `..`、絕對路徑、未知 namespace、未知
副檔名與不符合 UUID 的檔名。

## 本機測試

```powershell
node --test test/server.test.mjs
node --check src/server.mjs
```

## NAS 部署

把這個資料夾放到 NAS 的 `/volume1/docker/rueisiang-platform-storage`，在該目錄準備
只存在 NAS 的 `.env`：

```dotenv
STORAGE_ACCESS_TOKEN=<與 Codex relay 不同的高熵字串>
```

再用 Container Manager 或 Docker Compose 建立：

```bash
docker compose up -d --build
curl http://127.0.0.1:8790/healthz
```

目前 compose 將 `/volume1/rueisiang-platform` 以唯一的可寫 volume 掛到 container，
其餘 container filesystem 為唯讀，對外使用 NAS 的 `8790` port。Cloudflare Tunnel 的
`storage.rueisiang.com` 指向 `http://192.168.0.6:8790`，並保留 `x-storage-token`
驗證；不要把 8790 做 router port forwarding。

storage token 必須設成 NAS gateway 與 Worker 兩端的獨立 secret，不能重用 Codex relay token。
