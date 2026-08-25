import { useState } from "react";
import {
  composeTaiwanAddress,
  splitTaiwanAddress,
  taiwanDistricts,
  type TaiwanCity,
} from "../../lib/taiwan-address.js";
import { Alert, Button } from "../../ui/index.js";
import {
  parseTags,
  useCreateCustomer,
  useTagOptions,
  useUpdateCustomer,
  type Customer,
  type CustomerForm as Fields,
} from "./api.js";
import { TagPicker } from "./TagPicker.js";

const cities = Object.keys(taiwanDistricts) as TaiwanCity[];

function districtsOf(city: string): readonly string[] {
  return city in taiwanDistricts ? taiwanDistricts[city as TaiwanCity] : [];
}

interface Props {
  /** 有值就是編輯，沒有就是新增。 */
  customer?: Customer;
  onClose: () => void;
}

function emptyFields(): Fields {
  return { phone: "", name: "", email: "", address: "", tags: [] };
}

function fieldsOf(customer: Customer): Fields {
  return {
    phone: customer.phone,
    name: customer.name,
    email: customer.email,
    address: customer.address,
    tags: parseTags(customer.cyberbizTagsJson),
  };
}

/**
 * 新增與編輯共用一張表單。
 *
 * 送出時會先寫官網再寫本地（由 API 負責），所以失敗訊息可能來自 CYBERBIZ，
 * 例如「這支手機已存在」——那些訊息要原樣顯示，使用者才知道要改什麼。
 */
export function CustomerForm({ customer, onClose }: Props) {
  const [fields, setFields] = useState<Fields>(customer ? fieldsOf(customer) : emptyFields());
  /*
   * 地址在表單裡拆成三塊，送出時才組回單一字串。既有資料用 splitTaiwanAddress
   * 猜一次——猜不出縣市時整串會落在「詳細街道地址」，資料不會掉。
   */
  const [address, setAddress] = useState(() => splitTaiwanAddress(customer?.address ?? ""));

  // 表單一開就要能搜尋，所以直接啟用。
  const tagOptions = useTagOptions(true);
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  function set(patch: Partial<Fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  function submit() {
    const payload = {
      ...fields,
      address: composeTaiwanAddress(address.city, address.district, address.addressLine),
      // 拆開的三段也一起送，官網的地址欄位是分開的。
      ...address,
    };
    if (customer) update.mutate({ ...payload, id: customer.id }, { onSuccess: onClose });
    else create.mutate(payload, { onSuccess: onClose });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="customer-form-title">
        <div className="modal-head">
          <h2 id="customer-form-title">{customer ? "編輯客戶" : "新增客人"}</h2>
          <Button
            variant="icon"
            icon="close"
            onClick={onClose}
            disabled={pending}
            title="關閉"
            aria-label="關閉"
          />
        </div>

        <form
          className="modal-body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>電話<b>必填</b></span>
            <input
              autoFocus
              required
              inputMode="tel"
              placeholder="例如 0912 345 678"
              value={fields.phone}
              onChange={(event) => set({ phone: event.target.value })}
            />
            <small>電話是辨識客戶的主要欄位，同一支不會重複建立。</small>
          </label>

          <div className="field-grid">
            <label className="field">
              <span>姓名</span>
              <input value={fields.name} onChange={(event) => set({ name: event.target.value })} />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={fields.email}
                onChange={(event) => set({ email: event.target.value })}
              />
            </label>
          </div>

          {/*
            * 地址拆成縣市／區域／街道三格，但**存進去的還是單一字串**。
            * CYBERBIZ 回來的地址本來就是一整串，拆成三個欄位就得在每次同步時猜
            * 它的結構，猜錯會把資料弄髒。所以只在編輯的當下拆開，送出前組回去。
            *
            * 三格外面不再包一個「地址」標題：縣市、區域、地址三個標籤已經講完了
            * 這是什麼，多一層標題只是讓「地址」在同一塊裡出現兩次。改成靠間距
            * 把這一組跟上面分開。
            */}
          <div className="address-fields">
            <div className="field-grid">
              <label className="field">
                <span>縣市</span>
                <select
                  value={address.city}
                  onChange={(event) => {
                    // 換縣市時清掉區域——舊的區域幾乎不會屬於新的縣市。
                    setAddress({ ...address, city: event.target.value, district: "" });
                  }}
                >
                  <option value="">請選擇縣市</option>
                  {cities.map((city) => (
                    <option key={city} value={city}>{city}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>區域</span>
                <select
                  value={address.district}
                  disabled={!address.city}
                  onChange={(event) => setAddress({ ...address, district: event.target.value })}
                >
                  <option value="">{address.city ? "請選擇區域" : "請先選擇縣市"}</option>
                  {districtsOf(address.city).map((district) => (
                    <option key={district} value={district}>{district}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>地址</span>
              <input
                placeholder="例如：中山東路 138 號 2 樓"
                value={address.addressLine}
                onChange={(event) => setAddress({ ...address, addressLine: event.target.value })}
              />
            </label>
          </div>

          <TagPicker
            value={fields.tags}
            options={tagOptions.data ?? []}
            onChange={(tags) => set({ tags })}
          />

          {customer?.cyberbizCustomerId ? (
            <p className="muted form-foot">
              這位客戶已連結 CYBERBIZ 會員，儲存時會一併更新官網資料。
            </p>
          ) : null}

          {error ? <Alert tone="danger">{error.message}</Alert> : null}

          <div className="modal-actions">
            <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !fields.phone.trim()}>
              {pending ? "儲存中…" : customer ? "儲存" : "新增客人"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
