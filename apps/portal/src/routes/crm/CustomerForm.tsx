import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import {
  parseTags,
  useCreateCustomer,
  useUpdateCustomer,
  type Customer,
  type CustomerForm as Fields,
} from "./api.js";

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
  const [tagInput, setTagInput] = useState("");
  const [localOnly, setLocalOnly] = useState(false);

  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  function set(patch: Partial<Fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  function addTag() {
    const tag = tagInput.trim();
    if (!tag || fields.tags.includes(tag)) return;
    set({ tags: [...fields.tags, tag] });
    setTagInput("");
  }

  function submit() {
    if (customer) {
      update.mutate({ ...fields, id: customer.id }, { onSuccess: onClose });
    } else {
      create.mutate(
        { ...fields, ...(localOnly ? { sourceChannel: "manual" } : {}) },
        { onSuccess: onClose },
      );
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="customer-form-title">
        <div className="modal-head">
          <h2 id="customer-form-title">{customer ? "編輯客戶" : "新增客人"}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={pending}
            title="關閉"
            aria-label="關閉"
          >
            <Icon name="close" />
          </button>
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

          <label className="field">
            <span>地址</span>
            <input value={fields.address} onChange={(event) => set({ address: event.target.value })} />
          </label>

          <div className="field">
            <span>標籤</span>
            <div className="chips tight">
              {fields.tags.map((tag) => (
                <span className="chip" key={tag}>
                  {tag}
                  <button
                    type="button"
                    aria-label={`移除 ${tag}`}
                    onClick={() => set({ tags: fields.tags.filter((item) => item !== tag) })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="admin-form inline">
              <input
                aria-label="新增標籤"
                placeholder="輸入後按新增"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                }}
              />
              <button type="button" className="ghost-button" onClick={addTag}>
                新增
              </button>
            </div>
          </div>

          {!customer ? (
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={localOnly}
                onChange={(event) => setLocalOnly(event.target.checked)}
              />
              <span>
                只建在本平台，不同步到 CYBERBIZ
                <small>預設會在官網建立會員。勾起來的話這位客戶只存在這裡。</small>
              </span>
            </label>
          ) : null}

          {customer?.cyberbizCustomerId ? (
            <p className="muted form-foot">
              這位客戶已連結 CYBERBIZ 會員，儲存時會一併更新官網資料。
            </p>
          ) : null}

          {error ? <p className="form-error" role="alert">{error.message}</p> : null}

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={pending || !fields.phone.trim()}>
              {pending ? "儲存中…" : customer ? "儲存" : "新增客人"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
