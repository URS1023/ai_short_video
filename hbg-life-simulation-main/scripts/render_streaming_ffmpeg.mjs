import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toChineseNumber } from "./project_config.mjs";

const [projectArg = ".", outputArg = "renders/story-streaming.mp4"] = process.argv.slice(2);
const projectDir = path.resolve(projectArg);
const outputPath = path.resolve(projectDir, outputArg);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectStylePath = path.join(projectDir, "HBG_STYLE.json");
const projectStyle = fs.existsSync(projectStylePath) ? JSON.parse(fs.readFileSync(projectStylePath, "utf8")) : {};
const inferredOrientation = projectStyle.orientation ?? (projectStyle.canvas?.width < projectStyle.canvas?.height ? "portrait" : "landscape");
const defaultStyle = JSON.parse(fs.readFileSync(path.resolve(scriptDir, `../assets/hbg-style-${inferredOrientation}.json`), "utf8"));
const style = {
  ...defaultStyle,
  ...projectStyle,
  canvas: { ...defaultStyle.canvas, ...projectStyle.canvas },
  captions: { ...defaultStyle.captions, ...projectStyle.captions },
  opening: {
    ...defaultStyle.opening,
    ...projectStyle.opening,
    layout: { ...defaultStyle.opening.layout, ...projectStyle.opening?.layout },
  },
  chapters: { ...defaultStyle.chapters, ...projectStyle.chapters },
  audio: { ...defaultStyle.audio, ...projectStyle.audio },
};
const fps = Number(process.env.HBG_FPS ?? style.canvas.fps);
const width = Number(process.env.HBG_WIDTH ?? style.canvas.width);
const height = Number(process.env.HBG_HEIGHT ?? style.canvas.height);
const bitrate = process.env.HBG_VIDEO_BITRATE ?? style.canvas.videoBitrate;
const bgmVolume = Number(process.env.HBG_BGM_VOLUME ?? style.audio.bgmVolume);
const captionFontFamily = process.env.HBG_CAPTION_FONT_FAMILY ?? style.captions.fontFamily;
const captionFontSize = Number(process.env.HBG_CAPTION_FONT_SIZE ?? style.captions.fontSize);
const captionMarginV = Number(process.env.HBG_CAPTION_MARGIN_V ?? style.captions.bottom);
const captionBoxPadding = Number(process.env.HBG_CAPTION_BOX_PADDING ?? style.captions.boxPadding);
const captionAssBoxColor = process.env.HBG_CAPTION_ASS_BOX_COLOR ?? style.captions.assBoxColor;
const chapterFontFamily = style.chapters.fontFamily;
const chapterFontSize = Number(style.chapters.titleFontSize);
const chapterMarginL = Number(style.chapters.left);
const chapterMarginV = Number(style.chapters.top);
const chapterBoxPadding = Number(style.chapters.boxPadding);
const chapterAssBoxColor = style.chapters.assBoxColor;
const validateOnly = process.env.HBG_VALIDATE_ONLY === "1";
const keepWork = process.env.HBG_KEEP_STREAM_WORK === "1";

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(projectDir, name), "utf8"));
const storyboard = readJson("STORYBOARD.json");
const audio = readJson("audio_meta.json");
const spec = fs.existsSync(path.join(projectDir, "PROJECT_SPEC.json")) ? readJson("PROJECT_SPEC.json") : {};
// The HBG flash opening is optional. With opening.enabled=false the body starts at 0.
const openingEnabled = spec.opening?.enabled !== false;
const keepClipAmbience = spec.video?.keepAmbience === true;
const totalDuration = Number(audio.totalDuration.toFixed(3));
const bodyStart = openingEnabled ? Number(audio.opening.bodyStart.toFixed(3)) : 0;
const totalFrames = Math.round(totalDuration * fps);
const openingFrames = Math.round(bodyStart * fps);

const resolveMedia = (envName, ...candidates) => {
  const configured = process.env[envName];
  const values = configured ? [configured] : candidates.filter(Boolean);
  for (const value of values) {
    const resolved = path.resolve(projectDir, value);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error(`${envName} could not be resolved from: ${values.join(", ")}`);
};

const openingVideo = openingEnabled ? resolveMedia("HBG_OPENING_VIDEO", audio.opening.previewVideo, style.opening.approvedVideo) : null;
const lead = openingEnabled ? resolveMedia("HBG_LEAD_AUDIO", audio.opening.lead.path) : null;
const flash = openingEnabled ? resolveMedia("HBG_FLASH_AUDIO", audio.opening.flash.audio) : null;
const reveal = openingEnabled ? resolveMedia("HBG_REVEAL_AUDIO", audio.opening.reveal.path) : null;
const bgm = audio.bgm?.path || process.env.HBG_BGM_AUDIO ? resolveMedia("HBG_BGM_AUDIO", audio.bgm?.path) : null;
const narration = audio.body?.path || process.env.HBG_NARRATION_AUDIO ? resolveMedia("HBG_NARRATION_AUDIO", audio.body?.path) : null;

if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
  throw new Error("HBG_FPS, HBG_WIDTH, and HBG_HEIGHT must be positive numbers");
}
if (!Number.isFinite(bgmVolume) || bgmVolume < 0) throw new Error("HBG_BGM_VOLUME must be a non-negative number");
if (![captionFontSize, captionMarginV, captionBoxPadding, chapterFontSize, chapterMarginL, chapterMarginV, chapterBoxPadding].every(Number.isFinite)) throw new Error("caption/chapter style values must be finite numbers");
if (!Array.isArray(storyboard) || storyboard.length === 0) throw new Error("STORYBOARD.json has no scenes");

if (process.env.HBG_SKIP_STYLE_VALIDATION !== "1") {
  const styleValidation = spawnSync(process.execPath, [path.join(scriptDir, "validate_style_system.mjs"), projectDir], { cwd: projectDir, stdio: "inherit" });
  if (styleValidation.status !== 0) throw new Error(`style system validation failed with exit ${styleValidation.status}`);
}

const clipFor = (scene) => {
  const candidate = path.resolve(projectDir, scene.clip ?? `assets/generated/clips/${scene.id}.mp4`);
  return fs.existsSync(candidate) ? candidate : null;
};
for (const scene of storyboard) {
  const source = path.join(projectDir, scene.asset);
  if (!clipFor(scene) && !fs.existsSync(source)) throw new Error(`missing scene asset and clip: ${source}`);
}

const workDir = path.join(projectDir, "renders", `ffmpeg-work-${path.basename(outputPath, path.extname(outputPath))}`);
if (validateOnly) {
  console.log(JSON.stringify({
    status: "validated",
    projectDir,
    outputPath,
    totalDuration,
    totalFrames,
    openingFrames,
    scenes: storyboard.length,
    openingVideo,
    clips: storyboard.filter((scene) => clipFor(scene)).length,
    narration,
    bgm,
    bgmVolume,
  }, null, 2));
  process.exit(0);
}

if (fs.existsSync(workDir)) throw new Error(`work directory already exists: ${workDir}`);
fs.mkdirSync(path.join(workDir, "segments"), { recursive: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const run = (command, args, label) => {
  const result = spawnSync(command, args, { cwd: projectDir, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
};

const ffmpegVideoArgs = () => process.platform === "darwin"
  ? ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", bitrate, "-maxrate", "10M", "-bufsize", "20M", "-tag:v", "avc1"]
  : ["-c:v", "libx264", "-preset", "medium", "-crf", "18"];

const motionFilter = (motion, frames) => {
  const denominator = Math.max(1, frames - 1);
  const t = `on/${denominator}`;
  const states = {
    "zoom-in": { z: `1+0.13*${t}`, x: `(iw-iw/zoom)*(0.30+0.25*${t})`, y: `(ih-ih/zoom)*(0.55-0.10*${t})` },
    "zoom-out": { z: `1.13-0.13*${t}`, x: `(iw-iw/zoom)*(0.55-0.20*${t})`, y: `(ih-ih/zoom)*(0.40+0.10*${t})` },
    "pan-left": { z: "1.10", x: `(iw-iw/zoom)*(0.80-0.60*${t})`, y: `(ih-ih/zoom)*0.50` },
    "pan-right": { z: "1.10", x: `(iw-iw/zoom)*(0.20+0.60*${t})`, y: `(ih-ih/zoom)*0.50` },
    hold: { z: `1.01+0.025*${t}`, x: `(iw-iw/zoom)*0.50`, y: `(ih-ih/zoom)*0.50` },
  };
  const state = states[motion] ?? states.hold;
  return [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    `zoompan=z='${state.z}':x='${state.x}':y='${state.y}':d=${frames}:s=${width}x${height}:fps=${fps}`,
    "format=yuv420p",
  ].join(",");
};

const hasAudioStream = (file) => {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "audio";
};
const audioEncodeArgs = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

const segmentPaths = [];
let clipSegments = 0;
for (let index = 0; index < storyboard.length; index += 1) {
  const scene = storyboard[index];
  const nextStart = storyboard[index + 1]?.start ?? totalDuration;
  const frames = Math.round(nextStart * fps) - Math.round(scene.start * fps);
  if (frames < 1) throw new Error(`scene ${scene.id} has invalid frame count ${frames}`);
  const seconds = (frames / fps).toFixed(3);
  const segment = path.join(workDir, "segments", `${scene.id}.mp4`);
  segmentPaths.push(segment);
  const clip = clipFor(scene);
  // A clip's own sound is kept for dialogue scenes (or all scenes when video.keepAmbience is true).
  const keepClipSound = clip && (scene.keepAudio ?? (Boolean(scene.dialogue?.text) || keepClipAmbience)) && hasAudioStream(clip);
  if (clip) {
    // Generated motion: scale/crop to the canvas, hold the last frame if the clip is short, trim to the scene.
    const videoChain = `[0:v]fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},tpad=stop_mode=clone:stop_duration=15,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v]`;
    const audioChain = keepClipSound ? `;[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${seconds},asetpts=PTS-STARTPTS[a]` : "";
    const inputs = ["-i", clip, ...(keepClipSound ? [] : ["-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo"])];
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", `${videoChain}${audioChain}`, "-map", "[v]", "-map", keepClipSound ? "[a]" : "1:a", "-frames:v", String(frames), "-t", seconds, "-r", String(fps),
      ...ffmpegVideoArgs(), "-g", "60", "-pix_fmt", "yuv420p", ...audioEncodeArgs, segment], `scene ${scene.id} (clip)`);
    clipSegments += 1;
  } else {
    // Static fallback: deterministic zoom/pan over the still.
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", path.join(projectDir, scene.asset), "-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo",
      "-vf", motionFilter(scene.motion, frames), "-map", "0:v", "-map", "1:a", "-frames:v", String(frames), "-t", seconds, "-r", String(fps),
      ...ffmpegVideoArgs(), "-g", "60", "-pix_fmt", "yuv420p", ...audioEncodeArgs, segment,
    ], `scene ${scene.id}`);
  }
  if ((index + 1) % 10 === 0 || index === storyboard.length - 1) console.log(`rendered ${index + 1}/${storyboard.length} scenes (${clipSegments} from motion clips)`);
}

const concatList = path.join(workDir, "segments.txt");
fs.writeFileSync(concatList, segmentPaths.map((item) => `file '${item.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
const bodyVideo = path.join(workDir, "body.mp4");
run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-movflags", "+faststart", bodyVideo], "body concat");

const assTime = (seconds) => {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
const assEscape = (value) => String(value).replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N");
const assLines = [];
for (const caption of audio.captions ?? []) {
  assLines.push(`Dialogue: 0,${assTime(bodyStart + caption.start)},${assTime(bodyStart + caption.end)},Caption,,0,0,0,,${assEscape(caption.text)}`);
}
for (const chapterMeta of audio.chapters ?? []) {
  const first = storyboard.find((scene) => scene.chapter === chapterMeta.chapter);
  if (!first) continue;
  assLines.push(`Dialogue: 1,${assTime(first.start + 0.12)},${assTime(Math.min(first.start + 3, totalDuration))},Chapter,,0,0,0,,${assEscape(`第${toChineseNumber(chapterMeta.chapter)}幕  ${chapterMeta.title}`)}`);
}

const assPath = path.join(workDir, "captions.ass");
fs.writeFileSync(assPath, `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${captionFontFamily},${captionFontSize},&H00FFFFFF,&H00FFFFFF,${captionAssBoxColor},${captionAssBoxColor},-1,0,0,0,100,100,1,0,3,${captionBoxPadding},0,2,54,54,${captionMarginV},1
Style: Chapter,${chapterFontFamily},${chapterFontSize},&H00FFF8EF,&H00FFF8EF,${chapterAssBoxColor},${chapterAssBoxColor},-1,0,0,0,100,100,2,0,3,${chapterBoxPadding},0,7,${chapterMarginL},${chapterMarginL},${chapterMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${assLines.join("\n")}
`);

const filterAssPath = assPath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
const ms = (seconds) => Math.round(seconds * 1000);
const inputs = [];
const filters = [];
const mixLabels = [];
let inputCount = 0;
const addInput = (file) => {
  inputs.push("-i", file);
  inputCount += 1;
  return inputCount - 1; // ffmpeg input index
};
let bodyInput;
if (openingEnabled) {
  addInput(openingVideo);
  bodyInput = addInput(bodyVideo);
  filters.push(`[0:v]trim=start_frame=0:end_frame=${openingFrames},setpts=N/(${fps}*TB)[openingv]`, `[${bodyInput}:v]setpts=N/(${fps}*TB)[bodyv]`, `[openingv][bodyv]concat=n=2:v=1:a=0[basev]`);
} else {
  bodyInput = addInput(bodyVideo);
  filters.push(`[${bodyInput}:v]setpts=N/(${fps}*TB)[basev]`);
}
filters.push(`[basev]subtitles=filename='${filterAssPath}'[v]`);
// Sound that came with the generated clips (dialogue / ambience), placed after the opening.
filters.push(`[${bodyInput}:a]adelay=${ms(bodyStart)}:all=1[clipsound]`);
mixLabels.push("[clipsound]");
if (openingEnabled) {
  let i = addInput(lead); filters.push(`[${i}:a]adelay=${ms(audio.opening.lead.start)}:all=1[lead]`); mixLabels.push("[lead]");
  i = addInput(flash); filters.push(`[${i}:a]atrim=0:${audio.opening.flash.duration},adelay=${ms(audio.opening.flash.start)}:all=1[flash]`); mixLabels.push("[flash]");
  i = addInput(reveal); filters.push(`[${i}:a]adelay=${ms(audio.opening.reveal.start)}:all=1[reveal]`); mixLabels.push("[reveal]");
}
if (bgm) { const i = addInput(bgm); filters.push(`[${i}:a]atrim=0:${totalDuration},volume=${bgmVolume}[bgm]`); mixLabels.push("[bgm]"); }
if (narration) { const i = addInput(narration); filters.push(`[${i}:a]adelay=${ms(bodyStart)}:all=1[narration]`); mixLabels.push("[narration]"); }
// Loudness normalisation keeps the true peak below 0 dBFS and lands near streaming-platform loudness.
// Set HBG_LOUDNORM=0 to keep the raw mix, or HBG_LOUDNORM_I / HBG_LOUDNORM_TP to change the target.
const loudnorm = process.env.HBG_LOUDNORM === "0" ? "" : `,loudnorm=I=${process.env.HBG_LOUDNORM_I ?? -16}:TP=${process.env.HBG_LOUDNORM_TP ?? -1.5}:LRA=11,aresample=48000`;
filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0${loudnorm},atrim=0:${totalDuration}[a]`);

run("ffmpeg", [
  "-hide_banner", "-loglevel", "info", "-y", ...inputs,
  "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-r", String(fps), "-t", String(totalDuration),
  ...ffmpegVideoArgs(), "-g", "60", "-pix_fmt", "yuv420p", ...audioEncodeArgs, "-movflags", "+faststart", outputPath,
], "final assembly");

if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) throw new Error(`final output missing or empty: ${outputPath}`);
if (!keepWork) fs.rmSync(workDir, { recursive: true, force: true });
console.log(JSON.stringify({ outputPath, totalDuration, totalFrames, openingFrames, motionClips: clipSegments, openingEnabled, scenes: storyboard.length, workDir: keepWork ? workDir : null }, null, 2));
