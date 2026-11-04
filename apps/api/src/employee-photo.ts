import { HR_EMPLOYEE_PHOTO_MAX_BYTES, HR_EMPLOYEE_PHOTO_MAX_PIXELS, HR_EMPLOYEE_PHOTO_MAX_SIDE } from "@rueisiang/db/hr-profile-fields";
import { validateRasterImage } from "./image-validation.js";

export async function validateEmployeePhoto(bytes: Uint8Array, contentType: string) {
  const result = await validateRasterImage(bytes, contentType, {
    maxInputBytes: HR_EMPLOYEE_PHOTO_MAX_BYTES,
    maxPixels: HR_EMPLOYEE_PHOTO_MAX_PIXELS,
    maxSide: HR_EMPLOYEE_PHOTO_MAX_SIDE,
  });
  return result.contentType;
}
