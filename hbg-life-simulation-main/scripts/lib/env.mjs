import fs from "node:fs";
import path from "node:path";

/**
 * Load KEY=VALUE pairs from the nearest `.env` files (project dir and up to
 * three parents). Already-set process variables always win, so a real
 * environment variable overrides the file. Values are never printed.
 */
export function loadEnv(startDir = process.cwd(), maxLevels = 4) {
  let dir = path.resolve(startDir);
  for (let level = 0; level < maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (fs.existsSync(file)) {
      for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function requireEnv(name, hint = "") {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}${hint ? ` (${hint})` : ""}. Set it in .env or the process environment.`);
  return value;
}

/** Run async `worker(item, index)` over `items` with at most `limit` in flight. */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async (_, lane) => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, lane);
    }
  });
  await Promise.all(lanes);
  return results;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
