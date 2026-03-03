import { createMiddleware } from "hono/factory";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 20;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleans up expired entries every 5 minutes to prevent unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.windowStart > WINDOW_MS) store.delete(key);
  }
}, 5 * 60_000);

export const rateLimit = createMiddleware(async (c, next) => {
  const forwarded = c.req.header("x-forwarded-for");
  const firstForwarded = forwarded
    ? forwarded.split(",")[0]?.trim()
    : undefined;
  const ip = c.req.header("cf-connecting-ip") ?? firstForwarded ?? "unknown";
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    store.set(ip, { count: 1, windowStart: now });
    await next();
    return;
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS) {
    return c.json({ error: "Too many requests" }, 429);
  }

  await next();
});
