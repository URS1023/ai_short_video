#!/usr/bin/env node
// Batch image generation through any OpenAI-compatible Images API.
//
//   node gen_images.mjs PROJECT_DIR [--jobs FILE] [--only id1,id2] [--candidates N]
//                       [--concurrency N] [--size WxH] [--dry-run]
//
// Jobs file (JSONL, default assets/generated/prompts/jobs.jsonl), one per line:
//   {"id":"s001","prompt":"...","size":"1152x2048","candidates":3,"references":["assets/anchors/hero.png"]}
//
// Credentials come only from the environment / .env (never the project files):
//   IMAGE_API_BASE_URL  IMAGE_API_KEY  IMAGE_MODEL  IMAGE_SIZE
//   IMAGE_CONCURRENCY   IMAGE_CANDIDATES
//
// Outputs (resumable; existing files are skipped):
//   assets/generated/candidates/<id>_<k>.png   every candidate, normalised to the canvas
//   assets/generated/scenes/<id>.png           candidate 1, copied unless already present
//   assets/generated/prompts/gen_log.jsonl     one line per attempt (never contains the key)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv, requireEnv, runPool, sleep } from "./lib/env.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
loadEnv(projectDir);

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const spec = readJson(path.join(projectDir, "PROJECT_SPEC.json"), {});
const style = readJson(path.join(projectDir, "HBG_STYLE.json"), null);
const gen = spec.imageGeneration ?? {};

const baseUrl = (process.env.IMAGE_API_BASE_URL ?? gen.baseUrl ?? "").replace(/\/+$/, "");
const model = flag("--model") ?? process.env.IMAGE_MODEL ?? gen.model ?? "gpt-image-2";
const defaultSize = flag("--size") ?? process.env.IMAGE_SIZE ?? gen.size ?? "1152x2048";
const concurrency = Number(flag("--concurrency") ?? process.env.IMAGE_CONCURRENCY ?? gen.concurrency ?? 5);
// Optional provider parameters (see .env.example). When an aspect ratio is set, the
// tier + ratio pair replaces the pixel size field.
const sizeTier = process.env.IMAGE_SIZE_TIER ?? gen.sizeTier;
const aspectRatio = process.env.IMAGE_ASPECT_RATIO ?? gen.aspectRatio;
const quality = process.env.IMAGE_QUALITY ?? gen.quality;
const sizeFields = (job) => ({
  ...(aspectRatio ? { aspect_ratio: job.aspectRatio ?? aspectRatio, ...(sizeTier ? { size_tier: sizeTier } : {}) } : { size: job.size ?? defaultSize }),
  ...(quality ? { quality } : {}),
});
const defaultCandidates = Number(flag("--candidates") ?? process.env.IMAGE_CANDIDATES ?? gen.candidates ?? 1);
const retries = Number(gen.retries ?? 3);
const dryRun = args.includes("--dry-run");
const only = new Set((flag("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const jobsFile = path.resolve(projectDir, flag("--jobs") ?? "assets/generated/prompts/jobs.jsonl");

if (!baseUrl) throw new Error("IMAGE_API_BASE_URL is not set");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("concurrency must be an integer from 1 to 32");
const apiKey = dryRun ? "" : requireEnv("IMAGE_API_KEY");

const canvas = style?.canvas ?? (() => {
  const [w, h] = defaultSize.split("x").map(Number);
  return { width: w, height: h };
})();
// Canvas to normalise to. 1152x2048 requested -> 768x1344 delivered by default for portrait.
const targetW = Number(process.env.HBG_WIDTH ?? canvas.width);
const targetH = Number(process.env.HBG_HEIGHT ?? canvas.height);

if (!fs.existsSync(jobsFile)) throw new Error(`Jobs file not found: ${jobsFile}`);
const jobs = fs.readFileSync(jobsFile, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
  try {
    return JSON.parse(l);
  } catch {
    throw new Error(`Invalid JSON on line ${i + 1} of ${jobsFile}`);
  }
}).filter((job) => only.size === 0 || only.has(job.id));
for (const job of jobs) if (!job.id || !job.prompt) throw new Error(`Every job needs id and prompt: ${JSON.stringify(job).slice(0, 80)}`);

const dirs = {
  candidates: path.join(projectDir, "assets/generated/candidates"),
  scenes: path.join(projectDir, "assets/generated/scenes"),
  raw: path.join(projectDir, "assets/generated/raw"),
  prompts: path.join(projectDir, "assets/generated/prompts"),
};
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
const logFile = path.join(dirs.prompts, "gen_log.jsonl");
const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), model, ...entry })}\n`);

const attempts = [];
for (const job of jobs) {
  const count = Number(job.candidates ?? defaultCandidates);
  for (let k = 1; k <= count; k += 1) attempts.push({ job, k });
}
const candidatePath = ({ job, k }) => path.join(dirs.candidates, `${job.id}_${k}.png`);
const todo = attempts.filter((a) => !fs.existsSync(candidatePath(a)));

console.log(JSON.stringify({ jobs: jobs.length, attempts: attempts.length, toGenerate: todo.length, skipped: attempts.length - todo.length, model, size: defaultSize, canvas: `${targetW}x${targetH}`, concurrency, dryRun }));
if (dryRun) process.exit(0);

async function requestImage(job) {
  // job.references: one or more project-relative image paths (character anchors, prop sheets, locations).
  // With references the OpenAI-compatible /images/edits endpoint is used so identity carries over.
  const references = [job.references ?? job.reference ?? []].flat().filter(Boolean).map((file) => path.resolve(projectDir, file));
  for (const file of references) if (!fs.existsSync(file)) throw new Error(`reference image missing: ${file}`);
  let response;
  if (references.length > 0) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", job.prompt);
    for (const [key, value] of Object.entries(sizeFields(job))) form.append(key, String(value));
    form.append("n", "1");
    const field = references.length > 1 ? "image[]" : "image";
    for (const file of references) form.append(field, new Blob([fs.readFileSync(file)], { type: /\.png$/i.test(file) ? "image/png" : "image/jpeg" }), path.basename(file));
    response = await fetch(`${baseUrl}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(420_000) });
  } else {
    response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: job.prompt, ...sizeFields(job), n: 1 }),
      signal: AbortSignal.timeout(300_000),
    });
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200).replace(apiKey, "***")}`);
  const item = JSON.parse(text).data?.[0];
  if (!item) throw new Error("response has no data[0]");
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  const url = item.url ?? item.download_url;
  if (!url) throw new Error("response has neither b64_json nor url");
  // The image host rejects non-browser User-Agents with 403.
  const image = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" }, signal: AbortSignal.timeout(120_000) });
  if (!image.ok) throw new Error(`image download HTTP ${image.status}`);
  return Buffer.from(await image.arrayBuffer());
}

function normalise(rawFile, outFile) {
  const filter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${targetW}:${targetH}`;
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", rawFile, "-vf", filter, "-frames:v", "1", outFile], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg normalise failed: ${result.stderr.slice(0, 200)}`);
}

let ok = 0;
let failed = 0;
await runPool(todo, concurrency, async (attempt) => {
  const { job, k } = attempt;
  const started = Date.now();
  for (let tryNo = 1; tryNo <= retries; tryNo += 1) {
    try {
      const bytes = await requestImage(job);
      const rawFile = path.join(dirs.raw, `${job.id}_${k}.bin`);
      fs.writeFileSync(rawFile, bytes);
      normalise(rawFile, candidatePath(attempt));
      fs.rmSync(rawFile, { force: true });
      log({ id: job.id, k, ok: true, ms: Date.now() - started, tries: tryNo, size: job.size ?? defaultSize });
      ok += 1;
      if (ok % 10 === 0) console.log(`generated ${ok}/${todo.length}`);
      return;
    } catch (error) {
      log({ id: job.id, k, ok: false, tries: tryNo, error: String(error.message).slice(0, 300) });
      if (tryNo === retries) {
        failed += 1;
        console.error(`FAILED ${job.id}_${k}: ${String(error.message).slice(0, 160)}`);
        return;
      }
      await sleep(2000 * tryNo);
    }
  }
});

// Promote candidate 1 to the canonical scene image when no scene image exists yet.
for (const job of jobs) {
  const scene = path.join(dirs.scenes, `${job.id}.png`);
  const first = path.join(dirs.candidates, `${job.id}_1.png`);
  if (!fs.existsSync(scene) && fs.existsSync(first)) fs.copyFileSync(first, scene);
}
console.log(JSON.stringify({ generated: ok, failed, log: path.relative(projectDir, logFile) }));
process.exit(failed > 0 ? 1 : 0);
