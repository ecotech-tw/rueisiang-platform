# PRH-566 RFID TCP Gateway

這個 NAS 服務接收 PRH-566 的 TCP Client 連線，按 LF 分隔完整資料列，再以 HTTPS 轉送到 HR API。TCP 是 byte stream，因此程式會處理半筆資料與同一段資料內的多筆資料；不會對讀卡機送出未經原廠確認的 TCP 回覆。

目前實測樣本為 `0002 <8 位 HEX>\r\n`，但原廠尚未確認封包語意。Gateway 只保留並轉送原始資料，不把識別碼稱為 UID/CSN；HR API 負責依目前暫定格式接受或拒絕。Gateway log 不輸出原始封包、卡號或 token。

## 本機測試

```powershell
node --check src/server.mjs
node --test test/server.test.mjs
```

## Synology NAS 部署

此服務與平台上的 NAS storage gateway 分開部署，不共用 token、port 或 container。需要先把包含此 README 的 `tools/rfid-gateway` 資料夾複製到 NAS，例如：

```text
/volume1/docker/rueisiang-platform-rfid-gateway/
```

在 NAS 該資料夾內複製 `.env.example` 為 `.env`，並填入：

```dotenv
RFID_API_ORIGIN=https://platform.rueisiang.com
RFID_GATEWAY_TOKEN=<至少 32 字元的高熵隨機值>
RFID_DEVICE_ID=office-entrance
RFID_TCP_BIND=192.168.0.6
```

`RFID_GATEWAY_TOKEN` 必須與 HR API Worker 的 secret 同值，且不可重用 storage、Codex relay 或其他 gateway 的 token。產生方式可用 `openssl rand -hex 32`；將同一結果分別設為 Worker secret `RFID_GATEWAY_TOKEN` 與 NAS `.env` 的 `RFID_GATEWAY_TOKEN`。NAS `.env` 不可 commit 或提供給瀏覽器。

使用 SSH 登入 NAS 後：

```bash
cd /volume1/docker/rueisiang-platform-rfid-gateway
chmod 600 .env
docker compose up -d --build
docker compose ps
docker compose exec rfid-gateway node -e "fetch('http://127.0.0.1:8788/healthz').then(async r => console.log(r.status, await r.text()))"
```

健康檢查 endpoint 是容器內的 `8788`；不需 publish 到 NAS。Reader 的資料 port 是 NAS `192.168.0.6:6000/TCP`。也可在 DSM **Container Manager → Project → Create**，指定上述資料夾並部署 Compose project；更新檔案後重新 build/restart project。

### 切換既有 6000 listener

同一個 NAS IP/port 不能同時由兩個 listener 使用。如果目前有手動測試程序或舊 container 佔用 `6000`，新 container 會因 port bind 失敗。先確認現有服務與啟動方式，安排短暫切換：停止舊 listener，啟動本 container，再確認 Container Manager 顯示 healthy；不要同時啟動兩個服務搶同一 port。

### PRH-566 與網路防火牆

- PRH-566 設定為 TCP Client，Server IP `192.168.0.6`、Port `6000`。
- NAS 防火牆只允許讀卡機所在網段／IP 連入 TCP 6000；不要在 router 做 6000 的 port forwarding。
- Gateway 只需要 NAS 對外 HTTPS `443`，轉送至 `https://platform.rueisiang.com/api/internal/rfid/scans`。部署在其他環境時，才將 origin 換成該環境 HR API 的 HTTPS origin。
- Gateway 回傳 API HTTP 狀態只寫入不含卡號的 log。HTTP 200 表示有綁卡感應操作收到資料；HTTP 202 表示資料格式可接受、但目前沒有進行中的綁卡操作。HTTP 4xx 會記錄狀態並丟棄，不會自動重試；網路錯誤、429、5xx 最多重試三次。

目前這個 Gateway 以 CRLF/LF 行結尾作為實測封包 framing；若原廠資料顯示封包 framing 不同，應先修正 parser，不能靠調整 Reader UART 或猜測封包格式。
