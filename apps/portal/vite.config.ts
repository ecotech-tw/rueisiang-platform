import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

function readPort(raw: string | undefined, fallback: number, label: string): number {
  // API dev server uses the same validation in apps/api/src/dev/server.ts.
  const value = raw?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} 必須是 1–65535 的整數，目前是「${raw}」。`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  // loadEnv 的 prefix 刻意是空字串，讓 PowerShell 的 API_PORT/PORTAL_PORT 也能傳進來。
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "");
  const apiPortOverride = env.API_PORT?.trim();
  const apiPort = readPort(apiPortOverride || env.PORT?.trim(), 8787, apiPortOverride ? "API_PORT" : "PORT");
  const portalPort = readPort(env.PORTAL_PORT, 5173, "PORTAL_PORT");

  return {
    // Tailwind v4 沒有 tailwind.config.js——設定全寫在 styles.css 的 @theme 裡。
    plugins: [react(), tailwindcss()],
    server: {
      port: portalPort,
      strictPort: true,
      // 本機開發時把 /api 轉給 apps/api 的 dev server（見 README 的 Windows on ARM 說明）。
      // /dev 是那台伺服器提供的假登入頁，不轉的話會被 SPA 的萬用路由吃掉。
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
        "/dev": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
