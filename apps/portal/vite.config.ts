import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // 本機開發時把 /api 轉給 apps/api 的 dev server（見 README 的 Windows on ARM 說明）。
    // /dev 是那台伺服器提供的假登入頁，不轉的話會被 SPA 的萬用路由吃掉。
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/dev": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
