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

function customerBody(input: CyberbizCustomerInput): Record<string, unknown> {
  return {
    mobile: input.phone,
    name: input.name || undefined,
    email: input.email || undefined,
    address: {
      phone: input.phone,
      address1: input.addressLine || input.address,
      city: input.city || undefined,
      district: input.district || undefined,
    },
    ...(input.tags?.length ? { tags: input.tags } : {}),
  };
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

  return {
    async fetchOne(externalId) {
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`);
      return parseCyberbizCustomer(payload);
    },

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
        body: { customer: customerBody(input) },
      });
      return parseCyberbizCustomer(payload);
    },

    async update(externalId, input) {
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: { customer: customerBody(input) },
      });
      return parseCyberbizCustomer(payload);
    },

    async updateTags(externalId, tags) {
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: { customer: { tags } },
      });
      return parseCyberbizCustomer(payload);
    },

    async setBlocked(externalId, blocked) {
      const { payload } = await request(`/v1/customers/${encodeURIComponent(externalId)}`, {
        method: "PUT",
        body: { customer: { blocked } },
      });
      return parseCyberbizCustomer(payload);
    },
  };
}
