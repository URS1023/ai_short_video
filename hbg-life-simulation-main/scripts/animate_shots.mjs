#!/usr/bin/env node
// Turn each storyboard still into a short motion clip with a local ComfyUI
// MiniMax-H3 image-to-video workflow. H3 is an audio+video model, so a clip can
// also carry generated dialogue with lip movement, or ambience only.
//
//   node animate_shots.mjs PROJECT_DIR [--storyboard FILE] [--only s001,s002]
//                          [--engine-url http://host:8188,http://host:8189]
//                          [--steps 8] [--limit N] [--dry-run]
//
// Scene fields used (STORYBOARD.json or --storyboard):
//   id, asset, duration (seconds; from real timing), motionPrompt (what moves),
//   dialogue: { speaker?, text }, voice (voice description), ambience, keepAudio
//
// Configuration comes from PROJECT_SPEC.video, overridable by env / .env:
//   COMFY_URLS (comma list) or COMFY_URL [+ COMFY_URL_GPU1]; one job per instance runs at a time.
//
// Output (resumable): assets/generated/clips/<id>.mp4 and clips/manifest.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadEnv, runPool, sleep } from "./lib/env.mjs";

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
const video = spec.video ?? {};

const urls = (flag("--engine-url") ?? process.env.COMFY_URLS ?? [process.env.COMFY_URL, process.env.COMFY_URL_GPU1].filter(Boolean).join(",") ?? "")
  .split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
const dryRun = args.includes("--dry-run");
if (urls.length === 0 && !dryRun) throw new Error("No ComfyUI endpoint: set COMFY_URLS (or COMFY_URL) in .env, or pass --engine-url");

const cfg = {
  unet: video.unet ?? "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
  lora: video.lora ?? "",
  loraStrength: Number(video.loraStrength ?? 1),
  clip: video.clip ?? "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vae: video.vae ?? "minimax_h3_video_vae_int8_convrot.safetensors",
  audioVae: video.audioVae ?? "minimax_h3_audio_vae_fp32.safetensors",
  steps: Number(flag("--steps") ?? video.steps ?? 8),
  scheduler: video.scheduler ?? "simple",
  sampler: video.sampler ?? "res_multistep",
  fps: Number(video.fps ?? 24),
  width: Number(video.width ?? style?.canvas?.width ?? 768),
  height: Number(video.height ?? style?.canvas?.height ?? 1344),
  minSeconds: Number(video.minSeconds ?? 1.5),
  maxSeconds: Number(video.maxSeconds ?? 8),
  padSeconds: Number(video.padSeconds ?? 0.25),
  defaultAmbience: video.defaultAmbience ?? "only quiet natural ambience",
  timeoutMs: Number(video.timeoutMinutes ?? 30) * 60_000,
};
if (cfg.width % 32 !== 0 || cfg.height % 32 !== 0) throw new Error(`video width/height must be multiples of 32; got ${cfg.width}x${cfg.height}`);

const storyboardFile = path.resolve(projectDir, flag("--storyboard") ?? "STORYBOARD.json");
const scenes = readJson(storyboardFile, null);
if (!Array.isArray(scenes)) throw new Error(`Storyboard not found or not an array: ${storyboardFile}`);
const only = new Set((flag("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const limit = Number(flag("--limit") ?? Infinity);
const clipsDir = path.join(projectDir, "assets/generated/clips");
fs.mkdirSync(clipsDir, { recursive: true });
const manifestFile = path.join(clipsDir, "manifest.json");
const manifest = readJson(manifestFile, {});
const clipFile = (id) => path.join(clipsDir, `${id}.mp4`);

// ---- prompt + frame count -------------------------------------------------
function buildPrompt(scene) {
  const parts = [];
  parts.push((scene.motionPrompt ?? scene.visual ?? "Subtle natural motion. Slow camera push-in.").trim());
  const text = scene.dialogue?.text?.trim();
  if (text) {
    const voice = scene.voice ?? scene.dialogue?.voice ?? "a clear natural voice";
    parts.push(`The speaker's mouth moves in sync with the line, saying in Mandarin Chinese: "${text}".`);
    parts.push(`Audio: ${voice} clearly speaking the line in Mandarin Chinese, ${scene.ambience ?? "faint room tone"}; no music, no singing, no subtitles or generated text.`);
  } else {
    parts.push(`Audio: ${scene.ambience ?? cfg.defaultAmbience}; no speech, no singing, no music, no subtitles or generated text.`);
  }
  return parts.join(" ");
}
// H3 frame counts snap to the 17k+5 grid.
function frameCount(seconds) {
  let frames = Math.max(5, Math.round(seconds * cfg.fps));
  frames += (5 - (frames % 17) + 17) % 17;
  return frames;
}
const seedFor = (id) => parseInt(crypto.createHash("sha1").update(id).digest("hex").slice(0, 8), 16);

const plan = scenes.filter((s) => s.asset && (only.size === 0 || only.has(s.id))).slice(0, limit).map((scene) => {
  const seconds = Math.min(cfg.maxSeconds, Math.max(cfg.minSeconds, Number(scene.duration ?? cfg.minSeconds) + cfg.padSeconds));
  return { scene, seconds, frames: frameCount(seconds), prompt: buildPrompt(scene) };
});
const todo = plan.filter((p) => !fs.existsSync(clipFile(p.scene.id)));
console.log(JSON.stringify({ scenes: plan.length, toRender: todo.length, skipped: plan.length - todo.length, engines: urls.length, canvas: `${cfg.width}x${cfg.height}`, unet: cfg.unet, steps: cfg.steps, lora: cfg.lora || null, dryRun }));
if (dryRun) {
  for (const p of todo.slice(0, 3)) console.log(`${p.scene.id} ${p.frames}f: ${p.prompt}`);
  process.exit(0);
}

// ---- ComfyUI client ---------------------------------------------------------
async function jsonFetch(url, options, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), ...options });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function uploadImage(base, file) {
  const form = new FormData();
  const name = `hbg_${crypto.randomBytes(6).toString("hex")}.png`;
  form.append("image", new Blob([fs.readFileSync(file)], { type: "image/png" }), name);
  const result = await jsonFetch(`${base}/upload/image`, { method: "POST", body: form }, "upload");
  return result.name;
}

function buildGraph(imageName, plan) {
  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: cfg.unet, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: cfg.clip, type: "minimax", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: cfg.vae } },
    4: { class_type: "VAELoader", inputs: { vae_name: cfg.audioVae } },
    5: { class_type: "LoadImage", inputs: { image: imageName } },
    7: { class_type: "KSamplerSelect", inputs: { sampler_name: cfg.sampler } },
    8: { class_type: "RandomNoise", inputs: { noise_seed: seedFor(plan.scene.id) } },
  };
  let modelRef = ["1", 0];
  if (cfg.lora) {
    g[20] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: cfg.lora, strength_model: cfg.loraStrength } };
    modelRef = ["20", 0];
  }
  g[6] = { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: plan.prompt, width: cfg.width, height: cfg.height, length: plan.frames, first_frame: ["5", 0] } };
  g[9] = { class_type: "BasicScheduler", inputs: { model: modelRef, scheduler: cfg.scheduler, steps: cfg.steps, denoise: 1.0 } };
  g[10] = { class_type: "BasicGuider", inputs: { model: modelRef, conditioning: ["6", 0] } };
  g[11] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["8", 0], guider: ["10", 0], sampler: ["7", 0], sigmas: ["9", 0], latent_image: ["6", 1] } };
  g[12] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
  g[13] = { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } };
  g[14] = { class_type: "CreateVideo", inputs: { images: ["12", 0], fps: cfg.fps, audio: ["13", 0] } };
  g[15] = { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: `hbg/${plan.scene.id}`, format: "mp4", "format.codec": "h264" } };
  return g;
}

async function renderClip(base, item) {
  const source = path.resolve(projectDir, item.scene.asset);
  if (!fs.existsSync(source)) throw new Error(`missing image: ${source}`);
  const imageName = await uploadImage(base, source);
  const queued = await jsonFetch(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: buildGraph(imageName, item), client_id: crypto.randomUUID() }) }, "queue");
  const promptId = queued.prompt_id;
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    let entry;
    try {
      entry = (await jsonFetch(`${base}/history/${promptId}`, {}, "history"))[promptId];
    } catch {
      continue; // the server is busy decoding; keep polling
    }
    if (!entry) continue;
    const status = entry.status ?? {};
    if (status.status_str === "error") {
      const message = (status.messages ?? []).find((m) => m[0] === "execution_error")?.[1];
      throw new Error(`ComfyUI error: ${String(message?.exception_message ?? "unknown").slice(0, 300)}`);
    }
    if (!status.completed) continue;
    for (const output of Object.values(entry.outputs ?? {})) {
      const file = [...(output.images ?? []), ...(output.videos ?? [])].find((f) => /\.(mp4|webm|mov)$/i.test(f.filename));
      if (!file) continue;
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
      const response = await fetch(`${base}/view?${query}`, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`download HTTP ${response.status}`);
      const tmp = `${clipFile(item.scene.id)}.part`;
      fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
      fs.renameSync(tmp, clipFile(item.scene.id));
      const times = (status.messages ?? []).reduce((acc, m) => ({ ...acc, [m[0]]: m[1]?.timestamp }), {});
      return { seconds: times.execution_success && times.execution_start ? (times.execution_success - times.execution_start) / 1000 : null };
    }
    throw new Error("workflow finished without a video output");
  }
  throw new Error(`timed out after ${cfg.timeoutMs / 60000} minutes`);
}

let done = 0;
let failed = 0;
const started = Date.now();
await runPool(todo, urls.length, async (item, _index, lane) => {
  const base = urls[lane];
  for (let tryNo = 1; tryNo <= 2; tryNo += 1) {
    try {
      const info = await renderClip(base, item);
      manifest[item.scene.id] = { frames: item.frames, seconds: Number((item.frames / cfg.fps).toFixed(3)), renderSeconds: info.seconds, engine: base, unet: cfg.unet, steps: cfg.steps, dialogue: Boolean(item.scene.dialogue?.text) };
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      done += 1;
      console.log(`[${done + failed}/${todo.length}] ${item.scene.id} ${item.frames}f in ${info.seconds?.toFixed(0) ?? "?"}s on ${base}`);
      return;
    } catch (error) {
      if (tryNo === 2) {
        failed += 1;
        console.error(`FAILED ${item.scene.id}: ${String(error.message).slice(0, 200)}`);
      } else {
        await sleep(5000);
      }
    }
  }
});
console.log(JSON.stringify({ rendered: done, failed, wallSeconds: Math.round((Date.now() - started) / 1000) }));
process.exit(failed > 0 ? 1 : 0);
