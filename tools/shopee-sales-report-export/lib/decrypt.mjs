import fs from "node:fs/promises";
import { spawn } from "node:child_process";

async function isZipFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    return header[0] === 0x50 && header[1] === 0x4b;
  } finally {
    await handle.close();
  }
}

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exit ${code}`)));
    child.stdin.end(input);
  });
}

async function decryptWithMsoffcrypto(sourcePath, destinationPath, password) {
  const script = [
    "import json, sys, msoffcrypto",
    "payload = json.loads(sys.stdin.read())",
    "with open(payload['source'], 'rb') as source:",
    "    office = msoffcrypto.OfficeFile(source)",
    "    office.load_key(password=payload['password'])",
    "    with open(payload['destination'], 'wb') as destination:",
    "        office.decrypt(destination)",
  ].join("\n");
  const payload = JSON.stringify({ source: sourcePath, destination: destinationPath, password });
  for (const command of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    try {
      await run(command, ["-c", script], payload);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      // The next fallback gives Windows users the same experience even if Python
      // exists but msoffcrypto-tool has not been installed locally.
      break;
    }
  }
  throw new Error("找不到可用的 msoffcrypto-tool。");
}

async function decryptWithExcel(sourcePath, destinationPath, password) {
  if (process.platform !== "win32") throw new Error("加密 xlsx 在這個環境無法解密；請安裝 msoffcrypto-tool，或先提供未加密的 xlsx。");
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$source = ${quote(sourcePath)}
$destination = ${quote(destinationPath)}
$password = [Console]::In.ReadLine()
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$book = $null
try {
  $book = $excel.Workbooks.Open($source, 0, $true, 1, $password)
  $book.SaveAs($destination, 51, '', '', $false, $false)
} finally {
  if ($null -ne $book) { $book.Close($false); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($book) }
  $excel.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], `${password}\r\n`);
}

export async function prepareWorkbook(sourcePath, destinationPath, password = "") {
  if (await isZipFile(sourcePath)) {
    await fs.copyFile(sourcePath, destinationPath);
    return { encrypted: false };
  }
  if (!password) throw new Error("輸入檔是加密檔，請提供 --password。");
  try {
    await decryptWithMsoffcrypto(sourcePath, destinationPath, password);
  } catch (msoffcryptoError) {
    try {
      await decryptWithExcel(sourcePath, destinationPath, password);
    } catch (excelError) {
      throw new Error(`解密失敗：${excelError.message}。Linux/GCP 請先安裝 msoffcrypto-tool（${msoffcryptoError.message}）。`);
    }
  }
  return { encrypted: true };
}
