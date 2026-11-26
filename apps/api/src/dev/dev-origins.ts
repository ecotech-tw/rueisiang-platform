import type { NetworkInterfaceInfo } from "node:os";

/*
 * 本機 dev server 允許哪些前端 origin 呼叫 API。
 *
 * 只放 localhost 的話，用手機連同一個區網打開 http://192.168.x.x:5176 時，瀏覽器送出的 Origin
 * 是區網 IP，送出資料就會被 API 以「Origin not allowed」擋下。手機實測是常態，所以預設把這台
 * 電腦每張網卡的區網 IPv4 也加進來。
 *
 * 想自己指定就寫在 apps/api/.dev.vars 的 AUTH_APP_ORIGINS；從外面設環境變數沒有用，
 * turbo 只會轉傳 passThroughEnv 列出的變數。
 *
 * 網卡清單只在 dev server 啟動時讀一次：換 Wi-Fi 或 DHCP 換了 IP，要重開 dev server 才會放行新的位址。
 */
export function devAppOrigins(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  ports: readonly number[],
): string[] {
  const hosts = ["localhost", "127.0.0.1"];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !hosts.includes(address.address)) hosts.push(address.address);
    }
  }
  return ports.flatMap((port) => hosts.map((host) => `http://${host}:${port}`));
}
