import { findHrEmployeePhoto, HrError, updateHrEmployeePhoto } from "@rueisiang/db";
import { HR_EMPLOYEE_PHOTO_MAX_BYTES } from "@rueisiang/db/hr-profile-fields";
import { type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { validateEmployeePhoto } from "./employee-photo.js";
import { type AppEnv } from "./env.js";

type PhotoEmployee = { employmentId: string; revision: number; personKind: "employee" | "worker"; archivedAt: string | null };
export const employeePhotoBodyLimit = bodyLimit({ maxSize: HR_EMPLOYEE_PHOTO_MAX_BYTES + 64 * 1024, onError: () => { throw new HTTPException(413, { message: "大頭貼不能超過 5 MB。" }); } });

async function deleteObject(bucket: R2Bucket, objectKey: string) {
  try { await bucket.delete(objectKey); }
  catch (error) { console.error(JSON.stringify({ event: "hr.employee_photo_cleanup_failed", error: error instanceof Error ? error.message : "unknown" })); }
}
function requireBucket(c: Context<AppEnv>) {
  if (!c.env.UPLOADS) throw new HTTPException(503, { message: "尚未設定照片儲存空間。" });
  return c.env.UPLOADS;
}

// 身分與資料歸屬由各 route 決定；兩個入口共用檔案生命週期，避免修好一邊、另一邊仍誤刪。
export async function readEmployeePhoto(c: Context<AppEnv>, employmentId: string) {
  const photo = await findHrEmployeePhoto(c.get("db"), employmentId);
  if (!photo) throw new HTTPException(404, { message: "員工尚未上傳大頭貼。" });
  const object = await requireBucket(c).get(photo.objectKey);
  if (!object) throw new HTTPException(404, { message: "找不到大頭貼檔案，請重新上傳。" });
  return c.newResponse(object.body, { headers: { "Content-Type": photo.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
}
export async function uploadEmployeePhoto(c: Context<AppEnv>, employee: PhotoEmployee) {
  const bucket = requireBucket(c);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === "string" || Array.isArray(file)) throw new HTTPException(400, { message: "請選擇一張大頭貼。" });
  if (file.size === 0 || file.size > HR_EMPLOYEE_PHOTO_MAX_BYTES) throw new HTTPException(400, { message: "大頭貼必須是 5 MB 以內的非空圖片。" });
  const expectedRevision = Number(form.revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new HTTPException(400, { message: "請提供有效版本，並重新整理後操作。" });
  if (employee.personKind !== "employee" || employee.archivedAt || employee.revision !== expectedRevision) throw new HTTPException(409, { message: "員工已是未在職或資料已變更，請重新整理後再試。" });
  const bytes = await file.arrayBuffer();
  const contentType = await validateEmployeePhoto(new Uint8Array(bytes), file.type);
  const employmentId = employee.employmentId;
  const previous = await findHrEmployeePhoto(c.get("db"), employmentId);
  const id = crypto.randomUUID();
  const photo = { id, objectKey: `hr/employee-photos/${employmentId}/${id}`, contentType };
  await bucket.put(photo.objectKey, bytes, { httpMetadata: { contentType } });
  try { await updateHrEmployeePhoto(c.get("db"), employmentId, { revision: expectedRevision, photo }, c.get("user")); }
  catch (error) {
    let current: Awaited<ReturnType<typeof findHrEmployeePhoto>>;
    try { current = await findHrEmployeePhoto(c.get("db"), employmentId); }
    catch { console.error(JSON.stringify({ event: "hr.employee_photo_write_unconfirmed", employmentId, photoId: id })); throw error; }
    if (current?.id === id) console.warn(JSON.stringify({ event: "hr.employee_photo_write_reconciled", employmentId, photoId: id }));
    else {
      // 「目前未參照」不能證明未知傳輸錯誤已回滾；可能稍後才提交。
      if (error instanceof HrError && error.status === 409) await deleteObject(bucket, photo.objectKey);
      else console.error(JSON.stringify({ event: "hr.employee_photo_write_unconfirmed", employmentId, photoId: id }));
      throw error;
    }
  }
  if (previous) await deleteObject(bucket, previous.objectKey);
  return c.json({ id }, 201);
}
export async function removeEmployeePhoto(c: Context<AppEnv>, employmentId: string, revision: number) {
  const bucket = requireBucket(c);
  const previous = await findHrEmployeePhoto(c.get("db"), employmentId);
  const result = await updateHrEmployeePhoto(c.get("db"), employmentId, { revision, photo: null }, c.get("user"));
  if (previous) await deleteObject(bucket, previous.objectKey);
  return c.json(result);
}
