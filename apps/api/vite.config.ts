import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/containers": fileURLToPath(new URL("./src/test/cloudflare-containers.ts", import.meta.url)),
    },
  },
});
