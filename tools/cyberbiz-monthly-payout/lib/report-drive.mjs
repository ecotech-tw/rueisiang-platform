import { uploadXlsx, verifyFormulaByTempCopy } from "./drive.mjs";

/**
 * 每一個 staged report version 都重新上傳並驗證 workbook。
 * 不依賴 Drive 的同名檔案，避免舊 checksum 或先前驗證失敗的檔案被誤發布。
 */
export async function uploadAndVerifyReportWorkbook({
  token,
  filePath,
  name,
  folderId,
  firstDataRow,
  upload = uploadXlsx,
  verify = verifyFormulaByTempCopy,
}) {
  const uploaded = await upload(token, { filePath, name, folderId });
  const formulaCheck = await verify(token, uploaded.id, { firstDataRow });
  if (!formulaCheck.count) throw new Error("combined XLSX 上傳後公式沒有產生值。 ");
  return { ...uploaded, formulaCheck };
}
