-- =============================================================================
-- Rueisiang Platform — 目標 schema（第一階段）
--
-- 這份檔案是「重整之後資料庫長什麼樣」的單一來源，供 review 與討論用。
-- **它不是 migration**：實際的 migration 由 `packages/db` 改 drizzle schema 後
-- 用 `pnpm generate` 產生，資料搬移另外手寫（見
-- docs/platform-schema-migration-plan.md）。
--
-- 每張表為什麼這樣改，見 docs/platform-schema-overhaul.md。
--
-- 範圍：第一階段只動非小香的表。小香的 18 張表（assistant_*）第一階段完全不動，
-- 它們對外只有 created_by / updated_by / actor_id → users(id) 這一種相依，
-- 而 users 這一輪維持原樣。
--
-- 現況 51 張 → 這裡 31 張。
-- =============================================================================


-- =============================================================================
-- 權限
-- =============================================================================

/*
 * 統一的使用者表。
 *
 * 沿用兩個已驗證的設計：邀請制（status 從 'invited' 開始，Google 登入時必須
 * 已經有這一列），以及停權即時生效（授權判定每次請求都回這張表重讀）。
 */
CREATE TABLE users (
  id                      VARCHAR(36)  PRIMARY KEY,
  email                   VARCHAR(255) NOT NULL,
  google_subject          VARCHAR(255),
  -- Google 帳號上的姓名，每次登入都被覆寫。改名自 `name`：跟 display_name 放在
  -- 一起時「哪一個是使用者能改的」看不出來
  google_name             VARCHAR(255) NOT NULL DEFAULT '',
  -- 使用者自己設定的顯示名稱。有值時一律優先，登入不會動它
  display_name            VARCHAR(255) NOT NULL DEFAULT '',
  picture_url             VARCHAR(1000) NOT NULL DEFAULT '',
  -- 'invited' | 'active' | 'disabled'
  status                  VARCHAR(20)  NOT NULL DEFAULT 'invited',
  /*
   * 兩條登入路都通向同一列。邀請一律同時支援 Google 與帳密——新同事手上不一定
   * 有公司 Google 帳號，但邀請當下沒有人知道這件事。
   */
  password_hash           VARCHAR(255),
  -- 只存邀請 token 的 SHA-256。資料庫外洩時拿到的那一串換不到帳號
  invitation_token_hash   VARCHAR(255),
  invitation_expires_at   TIMESTAMP,
  -- 設過密碼的時間，用來在後台區分「還沒設」與「設了但沒登入過」
  password_set_at         TIMESTAMP,
  invited_by              VARCHAR(36),
  last_login_at           TIMESTAMP,
  created_at              TIMESTAMP    NOT NULL,
  updated_at              TIMESTAMP    NOT NULL,
  CHECK (status IN ('invited','active','disabled'))
);
CREATE UNIQUE INDEX idx_users_email                  ON users(email);
CREATE UNIQUE INDEX idx_users_google_subject         ON users(google_subject);
CREATE UNIQUE INDEX idx_users_invitation_token_hash  ON users(invitation_token_hash);
CREATE        INDEX idx_users_status                 ON users(status);


/* 角色。只有管理員角色用 is_system 保護，其餘都可由管理者維護。 */
CREATE TABLE roles (
  id          VARCHAR(36)  PRIMARY KEY,
  -- 改名自 `key`：SQL 裡到處都是 key，加上前綴才看得出是哪一種
  role_key    VARCHAR(100) NOT NULL UNIQUE,
  name        VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL DEFAULT '',
  is_system   INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL,
  updated_at  TIMESTAMP    NOT NULL
);


/*
 * 角色擁有的權限。
 *
 * permission 是字串鍵值（如 crm:customer:write），定義在 packages/auth 的
 * 程式碼裡而非資料表——放進 DB 只會讓「有哪些權限」與「程式檢查哪些權限」
 * 兩邊漂移。
 */
CREATE TABLE role_permission_grants (
  role_id    VARCHAR(36)  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission VARCHAR(255) NOT NULL,
  created_at TIMESTAMP    NOT NULL,
  PRIMARY KEY (role_id, permission)
);


/*
 * 使用者被指派的角色。
 *
 * 不保留 scope_type / scope_id：`packages/auth/src/rbac.ts` 的 can() 沒有
 * scope 參數，也就是說「範圍」從來沒有被真正檢查過。留著一個沒有人檢查的欄位
 * 比沒有更危險——它讓人以為權限已經按店別隔離了。
 */
CREATE TABLE user_role_assignments (
  user_id    VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    VARCHAR(36) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by VARCHAR(36),
  created_at TIMESTAMP   NOT NULL,
  PRIMARY KEY (user_id, role_id)
);


/*
 * 直接授予某個人的權限，繞過角色。
 *
 * 角色回答「這一類人能做什麼」，這張表回答「這一個人另外還能做什麼」。
 * 只加不減：跟角色帶來的取聯集，沒有「扣掉某個權限」的機制——減法會讓
 * 「這個人到底能做什麼」變成要同時看兩張表才算得出來，而授權判定是每個請求
 * 都要跑的路徑。
 */
CREATE TABLE user_permission_grants (
  user_id    VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(255) NOT NULL,
  granted_by VARCHAR(36),
  created_at TIMESTAMP    NOT NULL,
  PRIMARY KEY (user_id, permission)
);


-- =============================================================================
-- 檔案
-- =============================================================================

/*
 * 物件儲存的 metadata。
 *
 * 檔案 bytes 在 NAS，D1 只保存查詢、授權與清理需要的短資料。object_key 是
 * gateway 產生的唯一鍵，不接受前端自行指定路徑——讓前端指定的話，有人就能
 * 傳一個既有的 key 覆蓋掉別人的檔。
 */
CREATE TABLE media_objects (
  object_key       VARCHAR(1000) PRIMARY KEY,
  -- 'assistant' | 'wms' | 'reports'
  namespace        VARCHAR(100)  NOT NULL,
  scope_key        VARCHAR(255)  NOT NULL DEFAULT '',
  filename         VARCHAR(500)  NOT NULL DEFAULT '',
  content_type     VARCHAR(255)  NOT NULL,
  size             INTEGER       NOT NULL,
  checksum         VARCHAR(255)  NOT NULL,
  -- 現在只有 NAS；之後要換或並存時，不必靠 object_key 的前綴猜
  storage_provider VARCHAR(50)   NOT NULL DEFAULT 'nas',
  created_by       VARCHAR(36),
  created_at       TIMESTAMP     NOT NULL,
  expires_at       TIMESTAMP
);
/*
 * 只有這一支索引。清理排程每次要掃「哪些檔過期了」，沒有索引就是全表掃描；
 * partial 是因為絕大多數檔案沒有 expires_at，收進索引只是讓它變大。
 * namespace / scope_key 兩支不建：現在沒有任何查詢用得到（列某個倉位的照片
 * 是查 wms_zone_images，不是回頭掃這張表）。
 */
CREATE INDEX idx_media_objects_expires_at ON media_objects(expires_at)
  WHERE expires_at IS NOT NULL;


-- =============================================================================
-- 品項（items）
--
-- 改名自 products。裡面含包材與備品（紅紙袋、提袋），叫 products 會騙人。
-- =============================================================================

/*
 * 品項分類（營運分析用）。
 *
 * 與 wms_categories 分開是刻意的：倉儲作業的分類（好不好拿、放哪一區）跟
 * 營運分析的分類（賣得好不好）生命週期完全不同，共用一份會互相污染。
 *
 * parent_id **固定兩層**：圓餅圖先看大分類，展開才看小分類。不做無限層——
 * 遞迴查詢在 D1 上很貴，而且沒有人畫得出三層以上的圓餅圖。
 * 「未分類」用 NULL 表示，不做成一列資料（做成資料列的話它會被人改名、刪掉）。
 */
CREATE TABLE item_categories (
  id         VARCHAR(36)  PRIMARY KEY,
  -- RESTRICT：大分類底下還有小分類就不准刪。CASCADE 會連坐刪掉整棵子樹
  parent_id  VARCHAR(36)  REFERENCES item_categories(id) ON DELETE RESTRICT,
  name       VARCHAR(255) NOT NULL,
  color      VARCHAR(50)  NOT NULL DEFAULT 'rose',
  sort_order INTEGER      NOT NULL DEFAULT 0,
  active     INTEGER      NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL,
  updated_at TIMESTAMP    NOT NULL,
  -- 同一個父分類底下不可同名；不同父分類底下可以（「禮盒/大」與「補充包/大」）
  UNIQUE (parent_id, name)
);
CREATE INDEX idx_item_categories_parent ON item_categories(parent_id, sort_order);


/*
 * 品項。**全平台的商品身分樞紐**——WMS、CYBERBIZ 鏡像、報表對應全部指向這裡。
 *
 * 兩個軸是獨立的，不要混：
 *   source  —— 身分從哪來（cyberbiz | custom）。**不可變，是歷史事實**
 *   kind    —— 拿來做什麼（sellable | supply）。**我們的判斷**，同步不可覆寫
 *
 * 同步的所有權規則（等級同 crm-sync.ts 的四條不變條件）：
 *   1. name 只在**建立時**從官網帶入，之後同步**不覆寫**——我們可能改成
 *      內部看得懂的名字，被官網蓋回去就白改了
 *   2. kind / active / category_id **只有我們寫**，同步一律不碰
 *   3. 官網那一面的名稱與上下架寫在 cyberbiz_products（鏡像），不寫這裡
 *   4. 新同步進來預設 kind='sellable'——分錯看得見；反過來會默默消失在報表裡
 *
 * active（我們的）與 cyberbiz_products.published（官網的）必須獨立：官網下架
 * 不代表我們要從倉庫地圖上拿掉它。要棄用某品項就在官網下架，列保留——
 * 歷史報表還指著它。
 */
CREATE TABLE items (
  id          VARCHAR(36)  PRIMARY KEY,
  -- 'cyberbiz' | 'custom'
  source      VARCHAR(20)  NOT NULL,
  -- 'sellable'（賣得出去）| 'supply'（包材、備品）
  kind        VARCHAR(20)  NOT NULL DEFAULT 'sellable',
  sku         VARCHAR(255) NOT NULL,
  name        VARCHAR(500) NOT NULL,
  category_id VARCHAR(36)  REFERENCES item_categories(id) ON DELETE SET NULL,
  -- 官網同步進來，也供手動新增報表時自動帶入，不用人填
  list_price  INTEGER,
  active      INTEGER      NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL,
  updated_at  TIMESTAMP    NOT NULL,
  -- 代理主鍵 + 這條 UNIQUE：SKU 只在同一個來源內唯一，官網的 ABC 與自訂的 ABC
  -- 是兩回事
  UNIQUE (source, sku),
  CHECK (source IN ('cyberbiz','custom')),
  CHECK (kind IN ('sellable','supply'))
);
CREATE INDEX idx_items_category ON items(category_id, active);
CREATE INDEX idx_items_name     ON items(name);


/*
 * CYBERBIZ 商品目錄在 D1 的鏡像。與 items 共用主鍵的延伸表。
 *
 * 「這個品項有沒有連到官網」= 這張表有沒有該 item_id。不需要對應表——
 * 舊版的 cyberbiz_product_links 是「兩個獨立身分空間」的遺跡，身分統一之後
 * 連結是隱含的。
 *
 * ❌ 不存 inventory_quantity / safety_inventory_quantity：每筆訂單都會變，
 *    存進 D1 就是一份一定會過期的假資料。要庫存就即時打 CYBERBIZ API
 *    （Redis 快取），沒有任何 SQL 需要 join 它。
 * ❌ 不存 last_error：activity_events 的同步失敗事件已經有。
 *
 * sync_status 放這裡而不是 wms_items：同步是**目錄同步**（改名、標籤、上下架），
 * 對每個官網商品都適用，跟有沒有入庫無關。
 */
CREATE TABLE cyberbiz_products (
  item_id             VARCHAR(36)  PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  cyberbiz_product_id VARCHAR(255) NOT NULL,
  cyberbiz_variant_id VARCHAR(255) NOT NULL,
  -- 官網那一面的名稱：同步會覆寫，跟 items.name（我們的）分開
  product_name        VARCHAR(500) NOT NULL DEFAULT '',
  variant_name        VARCHAR(500) NOT NULL DEFAULT '',
  -- 官網下架後仍保留這一列：歷史報表還指著它
  published           INTEGER      NOT NULL DEFAULT 1,
  -- 欄位對應不上時可以回頭查
  raw_json            TEXT         NOT NULL DEFAULT '{}',
  cyberbiz_updated_at TIMESTAMP,
  -- 'synced' | 'failed'
  sync_status         VARCHAR(20)  NOT NULL DEFAULT 'synced',
  synced_at           TIMESTAMP    NOT NULL,
  UNIQUE (cyberbiz_product_id, cyberbiz_variant_id),
  CHECK (sync_status IN ('synced','failed'))
);


/*
 * 品項的組成（BOM）。禮盒由哪些東西組成。
 *
 * 這是**定義**，不是報表資料：報表永遠只存賣出去的那個 item（禮盒就是禮盒，
 * 不展開成用料），所以不會重複計算。要材料用量就用這張表乘出來。
 *
 * 兩種用法共用同一結構：
 *   BOM 空的 —— 只統計禮盒，不管內容物
 *   BOM 有填 —— 一樣統計禮盒，但材料紀錄完整
 *
 * 同一個禮盒在官網與蝦皮都賣時，兩筆外部對應指向同一個 item，組成只定義一次。
 */
CREATE TABLE item_components (
  parent_item_id    VARCHAR(36) NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  -- RESTRICT：還被別的東西當材料用就不准刪
  component_item_id VARCHAR(36) NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  quantity          INTEGER     NOT NULL,
  created_at        TIMESTAMP   NOT NULL,
  updated_at        TIMESTAMP   NOT NULL,
  PRIMARY KEY (parent_item_id, component_item_id),
  CHECK (parent_item_id <> component_item_id),
  CHECK (quantity > 0)
);
CREATE INDEX idx_item_components_component ON item_components(component_item_id);


-- =============================================================================
-- WMS
-- =============================================================================

/*
 * 倉儲分類（作業用）。與 item_categories 分開，理由見那張表的註解。
 */
CREATE TABLE wms_categories (
  id         VARCHAR(36)  PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  color      VARCHAR(50)  NOT NULL DEFAULT 'rose',
  active     INTEGER      NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL,
  updated_at TIMESTAMP    NOT NULL
);


/*
 * 倉位。倉庫裡的一個區域。
 *
 * ❌ 不再有 category：倉位的分類與品項的分類是兩件事，舊版讓 zones.category
 *    與 inventory_items.category 存同一批字串，改一邊就漂移。
 * ❌ 不要 zone_type：現在沒有任何查詢依它分流，加了只會有一欄永遠是同一個值。
 * ❌ x/y/width/height 搬到 wms_layout_elements：一個倉位在不同地圖上可以有
 *    不同位置，幾何屬於「這張圖」，不屬於倉位本身。
 * ❌ shelf_levels（JSON 陣列）改成 wms_shelves：層要被 wms_items.shelf_id
 *    指到，就必須有自己的 id。
 */
CREATE TABLE wms_zones (
  id         VARCHAR(36)  PRIMARY KEY,
  code       VARCHAR(100) NOT NULL UNIQUE,
  name       VARCHAR(255) NOT NULL,
  color      VARCHAR(50)  NOT NULL DEFAULT 'mint',
  notes      TEXT         NOT NULL DEFAULT '',
  active     INTEGER      NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL,
  updated_at TIMESTAMP    NOT NULL
);


/*
 * 倉位裡的層（上層／中層／底層）。
 *
 * 舊版存成 zones.shelf_levels 的 JSON 陣列，理由是「層只有名字、不會被參照」。
 * 現在會被參照了（wms_items.shelf_id），JSON 就不夠用。
 *
 * 舊版的 code / name / level / label 四欄收成 code + name：level 與 label
 * 在實際資料裡跟 code / name 是同一批值，四欄只是讓人不知道該填哪一個。
 */
CREATE TABLE wms_shelves (
  id         VARCHAR(36)  PRIMARY KEY,
  -- RESTRICT：層底下還有東西時，刪倉位不該讓「這批貨在哪」的答案消失
  zone_id    VARCHAR(36)  NOT NULL REFERENCES wms_zones(id) ON DELETE RESTRICT,
  code       VARCHAR(100) NOT NULL,
  name       VARCHAR(255) NOT NULL,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  active     INTEGER      NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL,
  updated_at TIMESTAMP    NOT NULL,
  UNIQUE (zone_id, code)
);
CREATE INDEX idx_wms_shelves_zone ON wms_shelves(zone_id, sort_order);


/*
 * 地圖。會有第二張（不同樓層、不同倉庫），所以不是單例。
 *
 * ❌ 不要 is_default，也不要 wms_settings.default_layout_id：程式 query
 *    limit 1 就夠了。一個「預設」欄位在只有一張圖時永遠是 1，在有兩張圖時
 *    才開始有意義——那時候再加。
 */
CREATE TABLE wms_layouts (
  id            VARCHAR(36)  PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  canvas_width  INTEGER      NOT NULL DEFAULT 1600,
  canvas_height INTEGER      NOT NULL DEFAULT 900,
  active        INTEGER      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL,
  updated_at    TIMESTAMP    NOT NULL
);


/*
 * 地圖上的每一個方塊——倉位、牆、走道、門口。
 *
 * **幾何全部收在這一張**。舊版 zones 與 layout_elements 各存一份 x/y/w/h，
 * 兩套拖曳邏輯、兩套碰撞判定，改一邊另一邊不會跟著動。
 *
 * x/y/width/height 是**百分比**不是像素：換畫布尺寸時整張圖等比例縮放，
 * 不用把每個方塊的座標重算一遍。
 */
CREATE TABLE wms_layout_elements (
  id           VARCHAR(36)  PRIMARY KEY,
  layout_id    VARCHAR(36)  NOT NULL REFERENCES wms_layouts(id) ON DELETE CASCADE,
  -- 'zone'（指向一個倉位）| 'decoration'（牆、走道、門口）
  element_type VARCHAR(50)  NOT NULL,
  zone_id      VARCHAR(36)  REFERENCES wms_zones(id) ON DELETE CASCADE,
  label        VARCHAR(255) NOT NULL DEFAULT '',
  color        VARCHAR(50)  NOT NULL DEFAULT 'rose',
  x            INTEGER      NOT NULL,
  y            INTEGER      NOT NULL,
  width        INTEGER      NOT NULL,
  height       INTEGER      NOT NULL,
  z_index      INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL,
  updated_at   TIMESTAMP    NOT NULL,
  CHECK (element_type IN ('zone','decoration')),
  -- 型別與外鍵綁死：zone 一定有 zone_id，decoration 一定沒有。
  -- 不綁的話會出現「指向倉位的牆」這種畫得出來但沒有意義的東西
  CHECK ((element_type = 'zone') = (zone_id IS NOT NULL))
);
CREATE INDEX idx_wms_layout_elements_layout ON wms_layout_elements(layout_id, z_index);
CREATE INDEX idx_wms_layout_elements_zone   ON wms_layout_elements(zone_id);


/*
 * 倉位的照片。
 *
 * 檔案的 metadata（檔名、大小、型別）在 media_objects，這裡只記「哪個倉位有
 * 哪些檔」。舊版 zone_images 把那三欄抄了一份，改上傳流程時兩邊會漂移，
 * 而且沒有任何東西會發現。
 */
CREATE TABLE wms_zone_images (
  zone_id    VARCHAR(36)   NOT NULL REFERENCES wms_zones(id) ON DELETE CASCADE,
  object_key VARCHAR(1000) NOT NULL REFERENCES media_objects(object_key) ON DELETE CASCADE,
  -- 一個倉位有多張照片時，同仁要能決定哪張放第一張
  sort_order INTEGER       NOT NULL DEFAULT 0,
  created_at TIMESTAMP     NOT NULL,
  PRIMARY KEY (zone_id, object_key)
);
CREATE INDEX idx_wms_zone_images_zone ON wms_zone_images(zone_id, sort_order);


/*
 * 進了倉庫的品項。items 的延伸表。
 *
 * 「有沒有進倉庫」= 這張表有沒有該 item_id。不是每個 item 都要有一列——
 * 官網新商品同步進來時只有 items，等有人真的把它放上貨架才建這裡的列。
 *
 * quantity / min_stock 是**我們的數字**：不是 CYBERBIZ 的東西（自製材料、
 * 包材）只有這裡有。實務上盤點是去官網改，再同步回來，所以官網有的品項
 * 這裡是鏡像值。
 *
 * ❌ 完全沒有 CYBERBIZ 欄位（last_synced_at / last_error / sync_status 全在
 *    cyberbiz_products）——同步失敗與同步時間屬於「官網那一面」，而且
 *    activity_events 已經記了每一次失敗。
 * ❌ 沒有 zone_id：倉位由 shelf_id 推導。兩個都存的話會出現「在 A 區的
 *    B 區第二層」這種矛盾。
 */
CREATE TABLE wms_items (
  item_id         VARCHAR(36) PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  wms_category_id VARCHAR(36) REFERENCES wms_categories(id) ON DELETE SET NULL,
  -- nullable：東西進了倉庫但還沒決定放哪一層是正常狀態
  shelf_id        VARCHAR(36) REFERENCES wms_shelves(id) ON DELETE RESTRICT,
  quantity        INTEGER     NOT NULL DEFAULT 0,
  unit            VARCHAR(50) NOT NULL DEFAULT '件',
  -- 低於這個數量就算需要補貨
  min_stock       INTEGER     NOT NULL DEFAULT 5,
  notes           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMP   NOT NULL,
  updated_at      TIMESTAMP   NOT NULL
);
CREATE INDEX idx_wms_items_shelf    ON wms_items(shelf_id);
CREATE INDEX idx_wms_items_category ON wms_items(wms_category_id);
-- 「需要補貨」清單：partial index 只收真的低於水位的列
CREATE INDEX idx_wms_items_low_stock ON wms_items(item_id)
  WHERE quantity < min_stock;


-- =============================================================================
-- CRM
-- =============================================================================

/*
 * 客戶。
 *
 * CYBERBIZ 欄位攤平在這裡而不是拆延伸表：不再支援 manual 客戶之後，每個新
 * 客戶都必定有官網身分，1:1 且必定存在的延伸表沒有意義。
 *
 * cyberbiz_customer_id 仍可為 NULL——歷史的本地客戶沒有它。NULL 與否本身
 * 就取代了舊版的 source_channel，不需要第二份真相。
 *
 * ❌ last_webhook_at：只寫不讀，而 activity_events 記了每一次 webhook。
 * ❌ sync_error：同上。
 * ❌ cyberbiz_tags_json：改成 crm_customer_tags 關聯表。
 */
CREATE TABLE crm_customers (
  id                   VARCHAR(36)  PRIMARY KEY,
  phone                VARCHAR(100) NOT NULL,
  -- 去掉分隔符號與國碼；重複判定與搜尋都用這一欄
  normalized_phone     VARCHAR(100) NOT NULL,
  name                 VARCHAR(255) NOT NULL DEFAULT '',
  email                VARCHAR(255) NOT NULL DEFAULT '',
  address              TEXT         NOT NULL DEFAULT '',

  -- NULL＝歷史的本地客戶；有值＝官網會員（以後全部都是）
  cyberbiz_customer_id VARCHAR(255) UNIQUE,
  cyberbiz_uid         VARCHAR(255),
  raw_json             TEXT         NOT NULL DEFAULT '{}',
  cyberbiz_updated_at  TIMESTAMP,
  sync_status          VARCHAR(20)  NOT NULL DEFAULT 'synced',
  synced_at            TIMESTAMP,

  -- 官網解除封鎖不會自動解除本地封鎖
  status               VARCHAR(20)  NOT NULL DEFAULT 'active',
  blocked_at           TIMESTAMP,

  created_at           TIMESTAMP    NOT NULL,
  updated_at           TIMESTAMP    NOT NULL,
  CHECK (status IN ('active','blocked')),
  CHECK (sync_status IN ('synced','failed'))
);
CREATE INDEX idx_crm_customers_phone      ON crm_customers(normalized_phone);
CREATE INDEX idx_crm_customers_status     ON crm_customers(status, updated_at);
CREATE INDEX idx_crm_customers_updated    ON crm_customers(updated_at);
CREATE INDEX idx_crm_customers_cb_updated ON crm_customers(cyberbiz_updated_at);
/*
 * 「資料不完整」統計卡的條件。沒有這支索引時它是全表掃描——一萬多列只為了數出
 * 少數幾筆。partial index 只收符合條件的列（實測 EXPLAIN 走 SCAN … USING INDEX，
 * 不再碰主表）。
 */
CREATE INDEX idx_crm_customers_incomplete ON crm_customers(id)
  WHERE name = '' OR address = '';


/* 標籤字典。改名自 customer_tag_catalog。 */
CREATE TABLE crm_tags (
  id         VARCHAR(36)  PRIMARY KEY,
  name       VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP    NOT NULL,
  updated_at TIMESTAMP    NOT NULL
);


/*
 * 客戶身上的標籤。
 *
 * 舊版存成 customers.cyberbiz_tags_json 的字串陣列，所以「每個標籤幾個人」
 * 要用 json_each 炸開、篩選要用 LIKE '%"VIP"%'（會誤中「VIP候選」）。
 *
 * 兩個結果：
 *   1. 字典（crm_tags）變成唯一來源，舊版的「字典裡沒有的標籤」聯集消失。
 *      同步遇到新標籤要**自動建字典列**。
 *   2. 同步從「整包字串換掉」變成「刪光重插」。⚠️ D1 免費每天 10 萬次寫入，
 *      **同步必須先比對，一樣就不要寫**。
 *
 * ❌ 不存 assigned_at：沒有消費者，而且整包覆寫式的同步會讓它每次都被重設成
 *    今天——一個永遠說謊的欄位比沒有更糟。
 */
CREATE TABLE crm_customer_tags (
  customer_id VARCHAR(36) NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  crm_tag_id  VARCHAR(36) NOT NULL REFERENCES crm_tags(id)      ON DELETE CASCADE,
  PRIMARY KEY (customer_id, crm_tag_id)
);
-- 「找出所有 VIP」：主鍵只涵蓋 customer 方向，反查沒有索引就是全表掃
CREATE INDEX idx_crm_customer_tags_tag ON crm_customer_tags(crm_tag_id);


/*
 * 客戶列表的儲存視圖。**全公司共用**，不屬於個人（沒有 user_id）。
 *
 * 用具名欄位不用 filters_json：篩選條件改名時，JSON 版本會**默默壞掉**
 * （舊視圖套用後沒反應），具名欄位則是型別會爆。這個專案本來就常跑
 * `pnpm generate`，加一欄的成本近乎零。
 *
 * ❌ channel 欄位：source_channel 沒了，前端那個下拉也要一起拿掉。
 * ❌ created_by_id：視圖是共用的，需要的是「去問誰」，而人可能已經離職——
 *    帳號刪掉時 email 快照還在。
 */
CREATE TABLE crm_saved_views (
  id               VARCHAR(36)  PRIMARY KEY,
  name             VARCHAR(255) NOT NULL UNIQUE,
  search           TEXT         NOT NULL DEFAULT '',
  status           VARCHAR(20)  NOT NULL DEFAULT 'all',
  tag              VARCHAR(255) NOT NULL DEFAULT 'all',
  sort_field       VARCHAR(100) NOT NULL DEFAULT 'updatedAt',
  sort_direction   VARCHAR(10)  NOT NULL DEFAULT 'desc',
  page_size        INTEGER      NOT NULL DEFAULT 10,
  created_by_email VARCHAR(255) NOT NULL DEFAULT '',
  created_at       TIMESTAMP    NOT NULL,
  updated_at       TIMESTAMP    NOT NULL
);


-- =============================================================================
-- 報表
-- =============================================================================

/*
 * 報表資料的據點／通路。
 *
 * 合併三處：舊 report_scopes（統計用）+ payout_stores（執行頁用）+
 * shopee_sales_settings（蝦皮的單一資料夾）。舊版 schema/tools.ts 的註解
 * 自己說了這個落差：「在這裡新增一家帳務 repo 沒有的店，執行時會失敗」——
 * 合併之後那個落差在結構上就不可能存在。
 *
 * 沒有 report_ 前綴：這是平台共用層（WMS、CRM 之後也會用到），跟 users、
 * items、media_objects 同一級。**不叫 stores**：裡面有蝦皮、momo、官網、
 * 全公司彙總，叫 stores 就是 products 裡塞紅紙袋的同一個坑。
 *
 * 兩個欄位各自回答不同問題，是獨立的兩個軸：
 *   source_type —— 資料從哪個系統來、哪個 driver 抓的（執行頁 filter 它）
 *   scope_kind  —— 業務上它是什麼（統計頁不 filter，全部一起比）
 *
 * ❌ 不做 report_sources 表：「有哪些來源」是程式碼（一個 workflow + 一個
 *    driver + 一個 route），不是資料。新增來源從來就不是「插一列」——與
 *    CLAUDE.md「權限鍵值寫在程式碼，不寫在資料表」同一條規則。
 * ❌ external_scope_id：CYBERBIZ POS 只給店名不給 ID，這欄只能填 name 的
 *    複本。
 *
 * active 只有一個，語意是**「還在營運」**。舊版 report_scopes.active 與
 * payout_stores.enabled 是兩個開關，同仁遲早會設成矛盾狀態。
 */
CREATE TABLE scopes (
  id                VARCHAR(36)   PRIMARY KEY,
  -- 'cyberbiz' | 'shopee'（唯一來源是 TS 的 ReportSourceType，不是資料表）
  source_type       VARCHAR(20)   NOT NULL,
  -- 'store'（實體門市）| 'channel'（蝦皮、momo、官網）| 'company'（全公司彙總）
  scope_kind        VARCHAR(20)   NOT NULL,
  name              VARCHAR(255)  NOT NULL,
  /*
   * 去掉所有空白、轉小寫。報表檔案裡的店名常常跟設定裡的差一個空格
   * （「誠品西門店 3F」vs「誠品西門店3F」），直接比會建出第二家店，
   * 報表數字被切成兩半。
   * ⚠️ 這一欄的移除條件見 migration plan 的 Phase 0：driver 改吃平台傳進去
   *    的 scope_id 之後才能拿掉，順序反了會靜靜壞掉。
   */
  normalized_name   VARCHAR(255)  NOT NULL,
  drive_folder_url  VARCHAR(1000) NOT NULL DEFAULT '',
  drive_folder_name VARCHAR(500)  NOT NULL DEFAULT '',
  sort_order        INTEGER       NOT NULL DEFAULT 0,
  active            INTEGER       NOT NULL DEFAULT 1,
  created_at        TIMESTAMP     NOT NULL,
  updated_at        TIMESTAMP     NOT NULL,
  UNIQUE (source_type, normalized_name),
  CHECK (source_type IN ('cyberbiz','shopee')),
  CHECK (scope_kind IN ('store','channel','company'))
);
CREATE INDEX idx_scopes_pick ON scopes(scope_kind, active, sort_order);


/*
 * 外部通路商品的對應。
 *
 * 一筆外部商品只會有一種結局：對應到某個 item，或明確被忽略。舊版拆成
 * product_sku_mappings 與 report_sku_ignores 兩張表，UNIQUE 鍵一模一樣，
 * 兩邊各插一列就矛盾——resolution 把它變成結構上不可能。
 *
 * 身分拆兩欄：蝦皮是「商品ID_規格ID」，舊資料只有商品ID。黏成一個字串之後
 * 每個查詢都要自己切一次（舊版 legacyShopeeExternalSku 有四個呼叫點），
 * 漏一個就默默對不到。拆開之後「精確優先、退回商品層級」是一句 SQL：
 *
 *   WHERE source_type='shopee' AND external_key=?
 *     AND external_variant_key IN (?, '')
 *   ORDER BY external_variant_key DESC LIMIT 1
 *
 * 組合包不放這裡：禮盒本身就是一個 item，組成寫在 item_components。同一個
 * 禮盒在官網與蝦皮都賣時，兩筆對應指向同一個 item，組成只定義一次。舊版的
 * product_bundle_components 有三個互斥外鍵（WMS／CYBERBIZ／自訂商品），
 * items 統一身分之後一個都不需要。
 */
CREATE TABLE report_external_products (
  id                   VARCHAR(36)  PRIMARY KEY,
  -- 'cyberbiz' | 'shopee' | 'legacy'（搬移前未確認來源的舊資料）
  source_type          VARCHAR(20)  NOT NULL,
  -- CYBERBIZ：SKU（大寫化）／蝦皮：商品ID
  external_key         VARCHAR(255) NOT NULL,
  -- CYBERBIZ：''／蝦皮：規格ID。'' 代表「這個商品的所有規格」
  external_variant_key VARCHAR(255) NOT NULL DEFAULT '',
  -- 報表裡看到的名稱，只為了讓人在對應頁認得出來
  external_name        VARCHAR(500) NOT NULL DEFAULT '',

  -- 'mapped' | 'ignored'
  resolution           VARCHAR(20)  NOT NULL,
  item_id              VARCHAR(36)  REFERENCES items(id) ON DELETE RESTRICT,
  ignored_reason       TEXT         NOT NULL DEFAULT '',

  created_at           TIMESTAMP    NOT NULL,
  updated_at           TIMESTAMP    NOT NULL,

  -- '' 不用 NULL：SQLite 的 UNIQUE 把每個 NULL 當成不同值，用 NULL 這條會失效
  UNIQUE (source_type, external_key, external_variant_key),
  CHECK (resolution IN ('mapped','ignored')),
  -- 兩個狀態綁死，不會出現「說是對應好了但指向 NULL」
  CHECK ((resolution = 'mapped') = (item_id IS NOT NULL)),
  -- 改成 mapped 之後理由留在原地，看到的人會以為它還被忽略著
  CHECK (resolution = 'ignored' OR ignored_reason = '')
);
-- 對應頁要反查「這個品項被哪些外部 SKU 指著」
CREATE INDEX idx_report_external_products_item ON report_external_products(item_id)
  WHERE item_id IS NOT NULL;


/*
 * 每次按下「執行」的紀錄。
 *
 * 三張併一張：cyberbiz_report_runs / payout_runs / shopee_sales_runs。
 * ⚠️ 其中前兩張記的其實是同一個按鈕（cyberbiz_report_runs.report_kind 已經
 *    有 'payout'）——那是現存的 bug，只是還沒有人發現對不起來。
 *
 * status 是**平台自己的紀錄**，不是 GitHub 的即時狀態（執行中仍要問 GitHub
 * API）。存它的理由是 Actions 的紀錄 90 天會過期，過期後這裡是唯一的歷史。
 *
 * 種類用兩個旗標而不是一個 enum：蝦皮一次做銷售與出金兩種，用 enum 的話每個
 * 「這次有沒有銷售」的判斷都要寫成 OR（舊版 cyberbiz-report-ingest.ts 重複了
 * 四次 `kind==='sales' || kind==='sales_and_payout'`），漏一個就漏掉蝦皮。
 *
 * ❌ trigger_kind：報表只有手動，cron 只補跑失敗的 webhook。
 * ❌ actor_id：只留 email 快照，帳號刪了仍看得出當初是誰跑的。
 * ❌ d1_import_eligible：舊版 `cyberbiz-reports.ts:44` 就是
 *    `periodKind === 'month' ? 1 : 0`，同一份真相寫兩欄。
 * ❌ started_at / completed_at：改用 updated_at，一欄涵蓋所有狀態
 *    （卡在 running 時看得出卡多久；完成時 created_at→updated_at 就是耗時）。
 */
CREATE TABLE report_runs (
  id                   VARCHAR(36)  PRIMARY KEY,
  -- 送進 workflow 的識別碼。workflow_dispatch 不回傳 run id，只能靠它認回來
  request_id           VARCHAR(255) NOT NULL UNIQUE,

  source_type          VARCHAR(20)  NOT NULL,
  imports_sales        INTEGER      NOT NULL DEFAULT 0,
  imports_payout       INTEGER      NOT NULL DEFAULT 0,

  -- 'month' | 'custom'
  period_kind          VARCHAR(20)  NOT NULL,
  start_date           VARCHAR(10)  NOT NULL,
  end_date             VARCHAR(10)  NOT NULL,

  -- 'queued' | 'running' | 'succeeded' | 'failed'
  status               VARCHAR(20)  NOT NULL DEFAULT 'queued',
  -- 存起來才給得出「看那次執行」的連結；否則要撈 GitHub API 比對 request_id
  workflow_run_id      VARCHAR(255),
  imported_sales_rows  INTEGER      NOT NULL DEFAULT 0,
  imported_payout_rows INTEGER      NOT NULL DEFAULT 0,
  skipped_rows         INTEGER      NOT NULL DEFAULT 0,
  last_error           TEXT         NOT NULL DEFAULT '',

  actor_email          VARCHAR(255) NOT NULL,

  created_at           TIMESTAMP    NOT NULL,
  updated_at           TIMESTAMP    NOT NULL,

  CHECK (imports_sales = 1 OR imports_payout = 1),
  CHECK (source_type IN ('cyberbiz','shopee')),
  CHECK (status IN ('queued','running','succeeded','failed')),
  CHECK (period_kind IN ('month','custom'))
);
CREATE INDEX idx_report_runs_created ON report_runs(created_at DESC);


/*
 * 一次執行跑了哪些 scope。
 *
 * 用子表不用 stores_json：「這家店上次跑是什麼時候」是真的會問的問題，
 * JSON 版本要 LIKE 掃全表。
 */
CREATE TABLE report_run_scopes (
  report_run_id VARCHAR(36) NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
  -- RESTRICT 是刻意的：有執行歷史的 scope 不准刪，要停用就設 active = 0
  scope_id      VARCHAR(36) NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  PRIMARY KEY (report_run_id, scope_id)
);
CREATE INDEX idx_report_run_scopes_scope ON report_run_scopes(scope_id);


/*
 * driver 產的執行報告（Markdown）。
 *
 * 舊版只存在 GitHub Actions 的 artifact 裡，**90 天過期**——而出金表動的是
 * 正式帳務的 Drive 檔案，「去年 8 月那次跑了什麼」必須查得到。
 *
 * 做成 1:1 側表而不是 report_runs 的欄位：執行清單頁不需要它，放主表會讓
 * 每次列清單都拖著整份 markdown。一年約幾百 KB。
 *
 * 截圖與 xlsx **不存**：xlsx 在 Google Drive 已經是永久正本，截圖只有失敗
 * 當下要看。要保存它們得讓 runner 多一把 NAS 寫入 token（runner 已握有
 * CYBERBIZ 帳密與 Google 憑證），代價與價值不成比例。
 */
CREATE TABLE report_run_reports (
  report_run_id VARCHAR(36) PRIMARY KEY REFERENCES report_runs(id) ON DELETE CASCADE,
  report_md     TEXT        NOT NULL DEFAULT ''
);


/*
 * 商品銷售月報。
 *
 * 兩張併一張（report_sales_monthly + report_manual_sales_monthly）。UNIQUE
 * 裡帶著 record_origin，所以同一格仍可同時有兩種來源——查詢時人工的優先，
 * 那條規則只在一個共用函式實作，不要在各統計裡各寫一次。
 *
 * 商品身分用 item_id 不用 SKU：SKU 會被改，改了之後同一個商品在報表裡會裂成
 * 兩筆。
 *
 * **不存名稱／分類／單價快照**，一律 join items：
 *   - 分類階層要快照的話得連父帶子抄兩欄，改階層時歷史就對不上
 *   - 同一個商品在報表裡出現兩個名字，同仁會以為是兩個商品
 *   - 單價 = sales_amount ÷ net_quantity，本來就算得出來
 *   - 要「當時叫什麼」時從 activity_events 查得到
 *     （idx_activity_entity_created 就是為這種查法建的）
 * ⚠️ 代價：改分類會回頭改變歷史報表的分佈。內部分析可接受；要拿去對帳的話
 *    這個決定要重新討論。
 *
 * 賣出去的是什麼就存什麼：禮盒就是禮盒，不展開成用料（見 item_components）。
 */
CREATE TABLE report_item_sales_monthly (
  scope_id         VARCHAR(36) NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  report_month     VARCHAR(7)  NOT NULL,   -- 'YYYY-MM'
  item_id          VARCHAR(36) NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  -- 'imported' | 'manual'
  record_origin    VARCHAR(20) NOT NULL,

  -- 匯入的列才有。刪掉執行紀錄不該連坐刪掉報表資料
  report_run_id    VARCHAR(36) REFERENCES report_runs(id) ON DELETE SET NULL,

  gross_quantity   INTEGER NOT NULL DEFAULT 0,
  return_quantity  INTEGER NOT NULL DEFAULT 0,
  net_quantity     INTEGER NOT NULL DEFAULT 0,
  sales_amount     INTEGER NOT NULL DEFAULT 0,

  -- 人工修訂列表直接顯示這一欄（ManualReports.tsx）；改成 join activity_events
  -- 的話一頁 20 列要查 20 次
  updated_by_email VARCHAR(255) NOT NULL DEFAULT '',

  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL,

  PRIMARY KEY (scope_id, report_month, item_id, record_origin),
  CHECK (record_origin IN ('imported','manual')),
  CHECK ((record_origin = 'imported') = (report_run_id IS NOT NULL)),
  -- 匯入的列不准有作者，否則「誰改的」會指著沒改過它的人
  CHECK (record_origin = 'manual' OR updated_by_email = '')
);
-- 趨勢圖與月份比較：先框月份再跨 scope
CREATE INDEX idx_item_sales_month ON report_item_sales_monthly(report_month, scope_id);
-- 單一商品的歷史
CREATE INDEX idx_item_sales_item  ON report_item_sales_monthly(item_id, report_month);


/*
 * 每日出金。兩張併一張（report_payout_daily + report_manual_payout_daily），
 * 與 report_item_sales_monthly 共用同一個「人工優先」函式。
 *
 * 表名拿掉 store：蝦皮不是 store，scope 才是正確的說法。
 */
CREATE TABLE report_payout_daily (
  scope_id         VARCHAR(36) NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  business_date    VARCHAR(10) NOT NULL,   -- 'YYYY-MM-DD'
  record_origin    VARCHAR(20) NOT NULL,

  report_run_id    VARCHAR(36) REFERENCES report_runs(id) ON DELETE SET NULL,
  payout_amount    INTEGER     NOT NULL DEFAULT 0,

  updated_by_email VARCHAR(255) NOT NULL DEFAULT '',

  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL,

  PRIMARY KEY (scope_id, business_date, record_origin),
  CHECK (record_origin IN ('imported','manual')),
  CHECK ((record_origin = 'imported') = (report_run_id IS NOT NULL)),
  CHECK (record_origin = 'manual' OR updated_by_email = '')
);
-- 通路出金比較：先框日期範圍再看所有通路，日期在前才走得到索引
CREATE INDEX idx_payout_daily_date ON report_payout_daily(business_date, scope_id);


/*
 * 匯入時被略過或出問題的外部商品。
 *
 * 舊版只回傳給 driver，結果留在 GitHub Actions 的 log 裡（90 天過期）。存進來
 * 之後平台才列得出「這些外部 SKU 還沒對應，請處理」——那本來就是既有流程
 * （補好對應重跑同一個月就會補回來），只是同仁得自己去翻 log。
 *
 * 一個 SKU 一列並帶 row_count，不是每一筆被略過的資料列各存一行：一個沒對應
 * 的熱門商品一次就能漏掉幾百列。
 *
 * ⚠️ 'ignored' 不是 issue：明確設定要忽略的 SKU 是正常狀態，混進「請處理」
 *    清單的話，每個月跳同一批，提醒很快就沒人看。
 */
CREATE TABLE report_ingest_issues (
  report_run_id        VARCHAR(36)  NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,

  external_key         VARCHAR(255) NOT NULL,
  external_variant_key VARCHAR(255) NOT NULL DEFAULT '',
  external_name        VARCHAR(500) NOT NULL DEFAULT '',

  -- 'unmapped'：查無對應／'ambiguous'：對到多筆／'invalid'：資料本身有問題
  issue_type           VARCHAR(20)  NOT NULL,
  detail               TEXT         NOT NULL DEFAULT '',
  row_count            INTEGER      NOT NULL DEFAULT 0,

  created_at           TIMESTAMP    NOT NULL,

  PRIMARY KEY (report_run_id, external_key, external_variant_key, issue_type),
  CHECK (issue_type IN ('unmapped','ambiguous','invalid'))
);
-- 「還沒處理的對應」清單：跨執行找同一個 SKU
CREATE INDEX idx_ingest_issues_key ON report_ingest_issues(external_key, external_variant_key);


-- =============================================================================
-- CYBERBIZ 事件
-- =============================================================================

/*
 * CYBERBIZ 推過來的事件。先落地再處理，處理失敗也留著——這樣才有辦法補跑，
 * 而不是叫對方重送。cron 每 15 分鐘掃 status='failed' 的補跑。
 *
 * 兩張併一張（cyberbiz_customer_webhooks + cyberbiz_product_webhooks）。
 * 它們自己的註解就說是「同一個角色，只是另一個模組的」，跟這個 codebase 之前
 * 把 customer_events + audit_logs 併成 activity_events 是同一個判斷。
 * 🎁 順便補上商品那邊漏掉的原始 payload——沒有它，欄位對應錯了就再也查不回去。
 *
 * 主鍵是 topic + 原始內容的雜湊（舊版 wms-webhook.ts 把同一個值同時存在 id
 * 與 payload_hash 兩欄）。CYBERBIZ 會重試，靠它認出重送。
 * ⚠️ 代價是「內容完全相同的兩個事件」會被當成重送擋掉（庫存 10→5→10→5）。
 *    CYBERBIZ 的 payload 帶時間戳所以實務上不會撞，但改動這裡時要記得。
 *
 * ⚠️ 這張表只進不出。清理排程見 migration plan 的收尾清單。
 */
CREATE TABLE cyberbiz_webhook_events (
  id                 VARCHAR(255) PRIMARY KEY,
  topic              VARCHAR(255) NOT NULL,
  -- 'customer' | 'product'
  entity_type        VARCHAR(20)  NOT NULL,
  -- 商品放 variant_id、會員放 cyberbiz_customer_id
  external_entity_id VARCHAR(255),

  payload_json       TEXT         NOT NULL DEFAULT '{}',

  -- 'processing' | 'processed' | 'ignored' | 'failed'
  status             VARCHAR(20)  NOT NULL DEFAULT 'processing',
  attempts           INTEGER      NOT NULL DEFAULT 1,
  last_error         TEXT         NOT NULL DEFAULT '',

  received_at        TIMESTAMP    NOT NULL,
  processed_at       TIMESTAMP,
  updated_at         TIMESTAMP    NOT NULL,

  CHECK (entity_type IN ('customer','product')),
  CHECK (status IN ('processing','processed','ignored','failed'))
);
-- cron 補跑：找失敗的
CREATE INDEX idx_webhook_events_status ON cyberbiz_webhook_events(status, received_at);
-- 「這個商品／這個會員的事件歷程」
CREATE INDEX idx_webhook_events_entity ON cyberbiz_webhook_events(entity_type, external_entity_id, received_at);


-- =============================================================================
-- 共用
-- =============================================================================

/*
 * 全系統共用的操作紀錄。欄位與現況完全一致，不動。
 *
 * ⚠️ **不可設過期清理**。這張表是「商品當時叫什麼」的唯一來源
 *    （report_item_sales_monthly 不存名稱快照就是靠它）。真的太大時的做法是
 *    把冷資料搬去 R2，不是刪掉。
 *
 * ⚠️ 搬移時 entity_type 的值要一起改，見 migration plan。不改的話「這個商品
 *    的歷程」只看得到搬移之後的紀錄——頁面正常、沒有錯誤、只是空的。
 */
CREATE TABLE activity_events (
  id           VARCHAR(36)  PRIMARY KEY,
  -- 刻意不做成 enum 或外鍵：新模組搬進來時只要開始寫自己的 entity_type 就好。
  -- 代價是打錯字不會被擋，所以寫入端統一走 recordActivity()，型別在那裡把關
  entity_type  VARCHAR(100) NOT NULL,
  entity_id    VARCHAR(255) NOT NULL,
  -- 存快照而不是靠 join：東西被刪掉之後紀錄還要看得懂
  entity_label VARCHAR(500) NOT NULL DEFAULT '',
  event_type   VARCHAR(100) NOT NULL,
  summary      TEXT         NOT NULL,
  -- 欄位級的變更（WMS 以此為主）；CRM 留空，它記整包 payload
  field        VARCHAR(255) NOT NULL DEFAULT '',
  old_value    TEXT,
  new_value    TEXT,
  payload_json TEXT         NOT NULL DEFAULT '{}',
  -- 'user' | 'system'
  actor_type   VARCHAR(20)  NOT NULL DEFAULT 'system',
  -- 刻意沒有 FK：帳號刪掉之後紀錄還要留著
  actor_id     VARCHAR(36),
  actor_email  VARCHAR(255),
  source       VARCHAR(100) NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'succeeded',
  error        TEXT,
  created_at   TIMESTAMP    NOT NULL
);
-- 「這個東西的歷程」——最常見的查詢，也是 #35 不存名稱快照的前提
CREATE INDEX idx_activity_entity_created ON activity_events(entity_type, entity_id, created_at);
CREATE INDEX idx_activity_source_created ON activity_events(source, created_at);
CREATE INDEX idx_activity_actor_created  ON activity_events(actor_id, created_at);
-- 整頁不帶條件時就是照時間倒序
CREATE INDEX idx_activity_created        ON activity_events(created_at);
