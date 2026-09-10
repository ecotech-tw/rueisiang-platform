import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

function readPort(raw: string | undefined, fallback: number, label: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} 必須是 1–65535 的整數，目前是「${raw}」。`);
  return port;
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "");
  const apiPortOverride = env.API_PORT?.trim();
  const apiPort = readPort(apiPortOverride || env.PORT?.trim(), 8787, apiPortOverride ? "API_PORT" : "PORT");
  const hrPortOverride = env.HR_PORT?.trim();
  const hrPort = readPort(hrPortOverride, 5176, "HR_PORT");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "0.0.0.0",
      port: hrPort,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
        "/dev": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
