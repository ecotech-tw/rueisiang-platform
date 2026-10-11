export interface HrProfileField {
  key: string;
  label: string;
  group: "basic" | "contact";
  type?: "date" | "email" | "tel" | "number" | "month";
  options?: readonly string[];
  maxLength?: number;
}

export const HR_PROFILE_FIELDS = [
  { key: "englishName", label: "英文姓名", group: "basic", maxLength: 100 },
  { key: "gender", label: "性別", group: "basic", options: ["男", "女", "其他", "不透露"] },
  { key: "nationality", label: "國籍", group: "basic", maxLength: 100 },
  { key: "birthDate", label: "生日", group: "basic", type: "date" },
  { key: "identityNumber", label: "身分證／居留證字號", group: "basic", maxLength: 30 },
  { key: "maritalStatus", label: "婚姻", group: "basic", options: ["未婚", "已婚", "其他", "不透露"] },
  { key: "identityGroup", label: "身分族群", group: "basic", maxLength: 100 },
  { key: "militaryStatus", label: "兵役", group: "basic", maxLength: 100 },
  { key: "dischargedOn", label: "退伍年月", group: "basic", type: "month" },
  { key: "heightCm", label: "身高（公分）", group: "basic", type: "number" },
  { key: "weightKg", label: "體重（公斤）", group: "basic", type: "number" },
  { key: "bloodType", label: "血型", group: "basic", options: ["A", "B", "AB", "O", "其他"] },
  { key: "personalEmail", label: "個人 Email", group: "contact", type: "email", maxLength: 254 },
  { key: "companyPhone", label: "公司電話", group: "contact", type: "tel", maxLength: 50 },
  { key: "extension", label: "分機", group: "contact", maxLength: 20 },
  { key: "homePhone", label: "住家電話", group: "contact", type: "tel", maxLength: 50 },
  { key: "mobilePhone", label: "行動電話", group: "contact", type: "tel", maxLength: 50 },
  { key: "registeredPhone", label: "戶籍電話", group: "contact", type: "tel", maxLength: 50 },
  { key: "registeredAddress", label: "戶籍地址", group: "contact", maxLength: 400 },
  { key: "mailingAddress", label: "通訊地址", group: "contact", maxLength: 400 },
  { key: "overseasAddress", label: "國外地址", group: "contact", maxLength: 400 },
  { key: "emergencyRelation", label: "緊急聯絡人關係", group: "contact", maxLength: 50 },
  { key: "emergencyName", label: "緊急聯絡人", group: "contact", maxLength: 100 },
  { key: "emergencyPhone", label: "緊急聯絡人電話", group: "contact", type: "tel", maxLength: 50 },
] as const satisfies readonly HrProfileField[];

export type HrProfileFieldKey = typeof HR_PROFILE_FIELDS[number]["key"];
export type HrPersonalData = Record<HrProfileFieldKey, string>;

export function emptyHrPersonalData(): HrPersonalData {
  return Object.fromEntries(HR_PROFILE_FIELDS.map(({ key }) => [key, ""])) as HrPersonalData;
}
