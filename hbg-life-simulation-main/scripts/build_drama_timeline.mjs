#!/usr/bin/env node
// Short-drama mode: turn an authored shot list into everything the pipeline needs.
//
//   node build_drama_timeline.mjs PROJECT_DIR [--shots SHOTS.json]
//
// SHOTS.json is an array of shots (authored by the agent while reading the story):
//   {
//     "id": "e01s001", "episode": 1, "title": "分镜说明(可选)",
//     "image": { "prompt": "...", "references": ["assets/anchors/hero.png"] },
//     "motionPrompt": "镜头缓慢推近,人物转头",
//     "dialogue": { "text": "台词", "offscreen": false },   // spoken line (on-screen speaker or narrator)
//     "caption": "只显示不发声的文字(如弹幕)",
//     "voice": "声音描述", "ambience": "环境音", "duration": 4.0   // duration optional
//   }
//
// Writes:
//   assets/generated/prompts/jobs.jsonl      one image job per shot (resumable with gen_images.mjs)
//   STORYBOARD.json                          all shots with durations (for animate_shots.mjs)
//   episodes/epNN/{STORYBOARD,audio_meta,PROJECT_SPEC,HBG_STYLE}.json  per-episode render inputs
//
// Render one episode:  node render_streaming_ffmpeg.mjs episodes/ep01 renders/ep01.mp4
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const shots = JSON.parse(fs.readFileSync(path.resolve(projectDir, flag("--shots") ?? "SHOTS.json"), "utf8"));
const style = JSON.parse(fs.readFileSync(path.join(projectDir, "HBG_STYLE.json"), "utf8"));
const specFile = path.join(projectDir, "PROJECT_SPEC.json");
const baseSpec = fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, "utf8")) : {};

const CAPTION_MAX = Number(style.captions?.maxChars ?? (style.canvas.width < style.canvas.height ? 14 : 18));
const SPEECH_CPS = 3.5; // Chinese characters per second incl. pauses, measured on generated clips
const round3 = (v) => Number(v.toFixed(3));
const visible = (text) => [...text.replace(/[\s，。！？；：、,.!?;:…—\-【】“”"']/gu, "")].length;

function speechDuration(text) {
  return Math.max(2.5, visible(text) / SPEECH_CPS + 0.7);
}

// Split a line into caption chunks no longer than CAPTION_MAX visible characters, breaking at punctuation first.
function splitCaption(text) {
  const clean = text.replace(/[【】]/g, "").replace(/\s+/g, "");
  if (visible(clean) <= CAPTION_MAX) return [clean];
  const units = clean.match(/[^，。！？；：、,.!?;:]+[，。！？；：、,.!?;:]?/gu) ?? [clean];
  const pieces = [];
  for (const unit of units) {
    if (visible(unit) <= CAPTION_MAX) { pieces.push(unit); continue; }
    const chars = [...unit];
    const count = Math.ceil(chars.length / CAPTION_MAX);
    const size = Math.ceil(chars.length / count);
    for (let i = 0; i < chars.length; i += size) pieces.push(chars.slice(i, i + size).join(""));
  }
  const packed = [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    if (last && visible(last + piece) <= CAPTION_MAX) packed[packed.length - 1] = last + piece;
    else packed.push(piece);
  }
  return packed;
}
const displayText = (text) => text.replace(/[，。！？；：、,.!?;:…]+$/u, "");

const episodes = new Map();
for (const shot of shots) {
  if (!shot.id || !shot.episode) throw new Error(`shot needs id and episode: ${JSON.stringify(shot).slice(0, 80)}`);
  const spoken = shot.dialogue?.text;
  const duration = round3(shot.duration ?? (spoken ? speechDuration(spoken) : (shot.caption ? Math.max(2.5, visible(shot.caption) / 5 + 1.2) : 3)));
  const entry = { ...shot, duration };
  if (!episodes.has(shot.episode)) episodes.set(shot.episode, []);
  episodes.get(shot.episode).push(entry);
}

// ---- image jobs ------------------------------------------------------------------------------
const jobsFile = path.join(projectDir, "assets/generated/prompts/jobs.jsonl");
fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
const jobs = shots.filter((s) => s.image?.prompt).map((s) => JSON.stringify({ id: s.id, prompt: s.image.prompt, ...(s.image.references?.length ? { references: s.image.references } : {}), ...(s.image.candidates ? { candidates: s.image.candidates } : {}) }));
fs.writeFileSync(jobsFile, `${jobs.join("\n")}\n`);

// ---- storyboards, captions, per-episode inputs ---------------------------------------------------
const sceneAsset = (id) => `assets/generated/scenes/${id}.png`;
const global = [];
const summary = [];
for (const [episode, list] of [...episodes.entries()].sort((a, b) => a[0] - b[0])) {
  const epName = `ep${String(episode).padStart(2, "0")}`;
  const epDir = path.join(projectDir, "episodes", epName);
  fs.mkdirSync(epDir, { recursive: true });
  let cursor = 0;
  const board = [];
  const captions = [];
  for (const shot of list) {
    const start = round3(cursor);
    const end = round3(cursor + shot.duration);
    const rel = "../..";
    board.push({ id: shot.id, chapter: episode, start, duration: shot.duration, end, motion: shot.motion ?? "zoom-in", asset: `${rel}/${sceneAsset(shot.id)}`, clip: `${rel}/assets/generated/clips/${shot.id}.mp4`, dialogue: shot.dialogue, keepAudio: Boolean(shot.dialogue?.text) || shot.keepAudio === true });
    global.push({ id: shot.id, episode, asset: sceneAsset(shot.id), duration: shot.duration, motionPrompt: shot.motionPrompt, dialogue: shot.dialogue, voice: shot.voice, ambience: shot.ambience, visual: shot.title });
    const text = shot.dialogue?.text ?? shot.caption;
    if (text) {
      const parts = splitCaption(text);
      const lead = shot.dialogue?.text ? 0.25 : 0.15;
      const windowStart = start + lead;
      const windowEnd = end - 0.15;
      const weights = parts.map((p) => Math.max(1, visible(p)));
      const total = weights.reduce((a, b) => a + b, 0);
      let at = windowStart;
      parts.forEach((part, i) => {
        const partEnd = i === parts.length - 1 ? windowEnd : at + ((windowEnd - windowStart) * weights[i]) / total;
        captions.push({ id: `${epName}-c${String(captions.length + 1).padStart(3, "0")}`, start: round3(at), end: round3(partEnd), text: displayText(part) });
        at = partEnd;
      });
    }
    cursor = end;
  }
  const total = round3(cursor);
  fs.writeFileSync(path.join(epDir, "STORYBOARD.json"), `${JSON.stringify(board, null, 2)}\n`);
  fs.writeFileSync(path.join(epDir, "audio_meta.json"), `${JSON.stringify({ provider: "generated-clips", syncMode: "clip-audio", totalDuration: total, narrationDuration: total, opening: undefined, captions, chapters: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(epDir, "PROJECT_SPEC.json"), `${JSON.stringify({ ...baseSpec, title: `${baseSpec.title ?? "drama"} ${epName}`, opening: { enabled: false }, video: { ...(baseSpec.video ?? {}), keepAmbience: false } }, null, 2)}\n`);
  fs.copyFileSync(path.join(projectDir, "HBG_STYLE.json"), path.join(epDir, "HBG_STYLE.json"));
  summary.push({ episode: epName, shots: list.length, seconds: total, captions: captions.length, dialogueShots: list.filter((s) => s.dialogue?.text).length });
}
fs.writeFileSync(path.join(projectDir, "STORYBOARD.json"), `${JSON.stringify(global, null, 2)}\n`);
const totalSeconds = summary.reduce((a, s) => a + s.seconds, 0);
console.log(JSON.stringify({ imageJobs: jobs.length, totalShots: shots.length, totalSeconds: round3(totalSeconds), episodes: summary }, null, 2));
