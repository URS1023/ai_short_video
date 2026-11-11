import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.mjs";

// Usage:
//   node init_project_style.mjs PROJECT_DIR [--orientation landscape|portrait] [--size WxH] [--fps N]
// Default orientation: HBG_ORIENTATION from the environment/.env, else landscape.
// --size picks any non-square canvas (multiples of 32 recommended when the
// local image-to-video engine is used); layout numbers are scaled from the
// matching orientation template by canvas width.
const args = process.argv.slice(2);
const valueFlags = new Set(["--orientation", "--size", "--fps"]);
let projectArg = ".";
for (let i = 0; i < args.length; i += 1) {
  if (valueFlags.has(args[i])) { i += 1; continue; }
  if (!args[i].startsWith("--")) { projectArg = args[i]; break; }
}
const projectDir = path.resolve(projectArg);
loadEnv(projectDir);

const flag = (name) => {
  const withEquals = args.find((value) => value.startsWith(`${name}=`));
  if (withEquals) return withEquals.split("=")[1];
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sizeText = flag("--size") ?? process.env.HBG_SIZE;
let orientation = flag("--orientation") ?? process.env.HBG_ORIENTATION ?? "landscape";
let width;
let height;
if (sizeText) {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(sizeText);
  if (!match) throw new Error("--size must look like 768x1344");
  width = Number(match[1]);
  height = Number(match[2]);
  if (width === height) throw new Error("square canvases are not supported");
  orientation = width < height ? "portrait" : "landscape";
}
if (!new Set(["landscape", "portrait"]).has(orientation)) throw new Error("--orientation must be landscape or portrait");

const target = path.join(projectDir, "HBG_STYLE.json");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(scriptDir, `../assets/hbg-style-${orientation}.json`);

if (!fs.existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`);
if (!fs.existsSync(templatePath)) throw new Error(`style template is missing: ${templatePath}`);

if (fs.existsSync(target)) {
  console.log(JSON.stringify({ status: "kept", path: target, requestedOrientation: orientation }, null, 2));
  process.exit(0);
}

const style = JSON.parse(fs.readFileSync(templatePath, "utf8"));
if (sizeText) {
  const factor = width / style.canvas.width;
  const scaleKeys = {
    captions: ["fontSize", "boxPadding", "borderRadius", "bottom", "maxWidth"],
    chapters: ["left", "top", "maxWidth", "kickerFontSize", "titleFontSize", "boxPadding"],
    layout: ["leadWidth", "leadFontSize", "flashLabelWidth", "flashLabelFontSize", "titleCardWidth", "primaryTitleFontSize", "secondaryTitleFontSize"],
  };
  const scale = (object, keys, base) => {
    for (const key of keys) if (typeof object[key] === "number") object[key] = Math.round(object[key] * base);
  };
  // Bottom margins follow the height ratio, widths and type follow the width ratio.
  const heightFactor = height / style.canvas.height;
  scale(style.captions, scaleKeys.captions.filter((k) => k !== "bottom"), factor);
  style.captions.bottom = Math.round(style.captions.bottom * heightFactor);
  scale(style.chapters, scaleKeys.chapters.filter((k) => k !== "top"), factor);
  style.chapters.top = Math.round(style.chapters.top * heightFactor);
  scale(style.opening.layout, scaleKeys.layout, factor);
  style.canvas.width = width;
  style.canvas.height = height;
}
const fps = flag("--fps");
if (fps) style.canvas.fps = Number(fps);

fs.writeFileSync(target, `${JSON.stringify(style, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ status: "created", path: target, orientation, canvas: style.canvas, scaledFrom: sizeText ? `${templatePath}` : null }, null, 2));
