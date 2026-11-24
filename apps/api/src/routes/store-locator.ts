import { buildPublicStoreLocator } from "@rueisiang/db";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { mediaCdnUrl } from "../media-cdn.js";

export const storeLocator = new Hono<AppEnv>();

storeLocator.get("/", async (c) => {
  const snapshot = await buildPublicStoreLocator(c.get("db"), (id) => mediaCdnUrl(c.env, id));
  c.header("Cache-Control", "public, max-age=60");
  return c.json(snapshot);
});
