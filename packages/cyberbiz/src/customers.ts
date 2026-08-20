import { cyberbizRequest, type CyberbizConfig, type RequestOptions } from "./http.js";

/**
 * CYBERBIZ 的會員 API。
 *
 * 解析的部分幾乎照抄 CRM 的 lib/cyberbiz.ts——那些欄位名稱的備選清單
 * （id / customer_id / member_id…）是一個一個試出來的，不是憑空寫的，
 * 重寫等於把踩過的坑再踩一次。
 */

export interface CyberbizCustomer {
  externalId: string;
  uid: string;
  phone: string;
  email: string;
  name: string;
  address: string;
  tags: string[];
  blocked: boolean;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
}

export interface CyberbizCustomerPage {
  customers: CyberbizCustomer[];
  page: number;
  perPage: number;
  totalPages: number;
  totalCustomers: number;
}

export interface CyberbizCustomerInput {
  phone: string;
  name: string;
  email: string;
  address: string;
  city?: string;
  district?: string;
  addressLine?: string;
  tags?: string[];
}

/** CYBERBIZ 對沒填姓名的會員會回這個字串，不該當成真的名字存下來。 */
const UNNAMED_CUSTOMER = "未命名會員";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** 會員資料可能被包在 customer / member / data 底下，也可能就是根物件。 */
function customerCandidate(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data);
  return (
    firstRecord(root.customer) ??
    firstRecord(root.member) ??
    firstRecord(data?.customer) ??
    firstRecord(data?.member) ??
    firstRecord(data?.customers) ??
    firstRecord(root.customers) ??
    firstRecord(root.data) ??
    firstRecord(payload) ??
    root
  );
}

function readAddress(customer: Record<string, unknown>): string {
  const address = asRecord(customer.address) ?? asRecord(customer.default_address);
  const nested = asRecord(address?.detail_address) ?? address ?? customer;
  const parts = ["zip", "zipcode", "postal_code", "city", "district", "area", "address1", "address2", "address"]
    .map((key) => firstString(nested, [key]))
    .filter(Boolean);
  return [...new Set(parts)].join(" ");
}

/**
 * 會員本人的電話。
 *
 * 只讀 mobile：address 底下那支是常用收件人的電話，不是會員身分，
 * 拿去做重複判定會把不同的人併成同一個。這是舊系統註解特別標出來的坑。
 */
function readPhone(customer: Record<string, unknown>): string {
  return firstString(customer, ["mobile"]);
}

function readTags(customer: Record<string, unknown>): string[] {
  const value = customer.tags_text ?? customer.tags ?? customer.customer_tags ?? customer.member_tags;
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = asRecord(item);
      return record ? firstString(record, ["name", "title", "label", "value"]) : "";
    })
    .filter(Boolean);
}

/**
 * CYBERBIZ 的時間字串沒有時區，實際上是台北時間。
 * 不補 +08:00 直接丟給 Date 會被當成 UTC，整批資料差八小時。
 */
function readTimestamp(customer: Record<string, unknown>, key: "created_at" | "updated_at"): string {
  const value = firstString(customer, [key]);
  if (!value) return "";

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}+08:00`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function parseCyberbizCustomer(payload: unknown): CyberbizCustomer {
  const customer = customerCandidate(payload);
  const firstName = firstString(customer, ["first_name", "firstname"]);
  const lastName = firstString(customer, ["last_name", "lastname"]);
  const status = firstString(customer, ["status", "state"]).toLowerCase();
  const name =
    firstString(customer, ["name", "full_name", "display_name"]) ||
    [lastName, firstName].filter(Boolean).join("");

  return {
    externalId: firstString(customer, ["id", "customer_id", "member_id", "customerId"]),
    uid: firstString(customer, ["uid", "customer_uid", "member_uid"]),
    phone: readPhone(customer),
    email: firstString(customer, ["email", "email_address"]),
    name: name === UNNAMED_CUSTOMER ? "" : name,
    address: readAddress(customer),
    tags: readTags(customer),
    blocked:
      customer.blocked === true ||
      customer.blacklisted === true ||
      ["blocked", "blacklisted", "disabled"].includes(status),
    createdAt: readTimestamp(customer, "created_at"),
    updatedAt: readTimestamp(customer, "updated_at"),
    raw: customer,
  };
}

/**
 * 收件地址。
 *
 * 地址沒改過時，把官網原本的 zip / country / province 原封送回去。只送
 * address1 的話那幾個欄位會被清成空的——它們是超商取貨在用的，清掉之後
 * 客戶下次結帳才會發現。
 */
function addressBody(
  input: CyberbizCustomerInput,
  current?: CyberbizCustomer,
): Record<string, unknown> {
  const currentAddress = asRecord(current?.raw.address) ?? asRecord(current?.raw.default_address);
  const currentDetail = asRecord(currentAddress?.detail_address) ?? currentAddress;
  const unchanged = Boolean(current && input.address.trim() === current.address.trim());

  const body: Record<string, unknown> = {
    phone: input.phone,
    address1: unchanged
      ? firstString(currentDetail ?? {}, ["address1", "address"])
      : input.addressLine || input.address,
  };

  if (unchanged && currentDetail) {
    for (const key of ["zip", "country", "province", "city", "district", "address2"] as const) {
      const value = firstString(currentDetail, [key]);
      if (value) body[key] = value;
    }
  } else {
    if (input.city) body.city = input.city;
    if (input.district) body.district = input.district;
  }

  return body;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * 會員的請求內容。照抄 CRM 的 cyberbizCustomerBody，每一項都是打過回應才知道的。
 *
 * **欄位放在最上層，不要包在 `customer` 底下。** 包起來的話 CYBERBIZ 一個欄位都
 * 讀不到，回的是「name 缺失、email、mobile 缺失、至少需要提供一個參數、password
 * 缺失」——連明明填了的電話也算缺，錯誤訊息完全看不出真正的原因是包錯層。
 *
 * 建立時另外補三個欄位。它們在 CYBERBIZ 是必填，但對這個系統沒有意義：客戶不會
 * 自己登入官網，密碼就給一組隨機的；超商取貨與行銷同意預設關閉，要開是客戶自己
 * 在官網開。這樣這邊才能維持「只有電話是必填」。
 */
function customerBody(
  input: CyberbizCustomerInput,
  creating: boolean,
  current?: CyberbizCustomer,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // 姓名沒填就送官網自己的預設字串。空字串會被當成「name 為空」擋下來。
    name: input.name || UNNAMED_CUSTOMER,
    address: addressBody(input, current),
  };

  /*
   * 更新時，官網原本就沒有 mobile 的會員不要順手補上去：那支電話是這邊的辨識
   * 依據，寫進官網等於幫對方認領一個身分，之後同步會對錯人。建立時當然要送。
   */
  const currentMobile = current ? firstString(current.raw, ["mobile"]) : "";
  if (creating || currentMobile) body.mobile = input.phone;
  if (input.email) body.email = input.email;
  // 標籤是逗號字串（tags_text），不是陣列。送陣列的話官網收下但存不進去。
  if (input.tags) body.tags_text = normalizeTags(input.tags).join(",");

  if (creating) {
    body.password = `Ruei!${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`;
    body.enable_cvs_pickup = false;
    body.accepts_marketing = false;
  }

  return body;
}

export interface CyberbizCustomerClient {
  fetchOne(externalId: string): Promise<CyberbizCustomer>;
  fetchPage(page?: number, perPage?: number): Promise<CyberbizCustomerPage>;
  create(input: CyberbizCustomerInput): Promise<CyberbizCustomer>;
  update(externalId: string, input: CyberbizCustomerInput): Promise<CyberbizCustomer>;
  updateTags(externalId: string, tags: string[]): Promise<CyberbizCustomer>;
  setBlocked(externalId: string, blocked: boolean): Promise<CyberbizCustomer>;
}

export function createCustomerClient(
  config: CyberbizConfig,
  options: RequestOptions = {},
): CyberbizCustomerClient {
  const request = (path: string, extra: RequestOptions = {}) =>
    cyberbizRequest(config, path, { ...options, ...extra });

  /* 提到外面：update() 送出前要先讀現況，不想為此繞回 client 物件自己。 */
  const fetchOne = async (externalId: string) => {
    const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`);
    return parseCyberbizCustomer(payload);
  };

  /**
   * 官網回應不一定把剛送出去的欄位原樣回傳（沒填姓名時回的是「未命名會員」）。
   * 缺的用送出去的值補回來——呼叫端拿這個結果寫進本地資料庫，少一個欄位就是
   * 本地少一筆資料。
   */
  const withInput = (customer: CyberbizCustomer, input: CyberbizCustomerInput): CyberbizCustomer => {
    const tags = normalizeTags(input.tags ?? []);
    return {
      ...customer,
      phone: input.phone,
      name: input.name,
      email: input.email,
      address: input.address,
      tags: customer.tags.length ? customer.tags : tags,
    };
  };

  return {
    fetchOne,

    async fetchPage(page = 1, perPage = 50) {
      const { payload, headers } = await request(`/v1/customers?page=${page}&per_page=${perPage}`);
      const root = asRecord(payload) ?? {};
      const list = Array.isArray(root.customers)
        ? root.customers
        : Array.isArray(root.data)
          ? root.data
          : Array.isArray(payload)
            ? payload
            : [];

      // 總頁數優先看 header：CYBERBIZ 的 body 不一定帶分頁資訊。
      const totalPages = Number(headers.get("x-total-pages") || root.total_pages || 0);
      const totalCustomers = Number(headers.get("x-total-count") || root.total_count || list.length);

      return {
        customers: list.map((item) => parseCyberbizCustomer(item)),
        page,
        perPage,
        totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1,
        totalCustomers: Number.isFinite(totalCustomers) ? totalCustomers : list.length,
      };
    },

    async create(input) {
      const { payload } = await request("/v1/customers", {
        method: "POST",
        body: customerBody(input, true),
      });
      return withInput(parseCyberbizCustomer(payload), input);
    },

    async update(externalId, input) {
      // 先讀現況：地址沒改時要把官網原本的欄位原樣送回去，見 addressBody。
      const current = await fetchOne(externalId);
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: customerBody(input, false, current),
      });
      return withInput(parseCyberbizCustomer(payload), input);
    },

    async updateTags(externalId, tags) {
      const normalized = normalizeTags(tags);
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: { tags_text: normalized.join(",") },
      });
      // 回應的 tags 不一定即時，直接用送出去的值。
      return { ...parseCyberbizCustomer(payload), tags: normalized };
    },

    async setBlocked(externalId, blocked) {
      // 官網沒有 blocked 這個欄位，停權是改 status。送 blocked 等於什麼都沒做。
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: { status: blocked ? "disabled" : "enabled" },
      });
      return parseCyberbizCustomer(payload);
    },
  };
}
