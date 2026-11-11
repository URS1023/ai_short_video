import fs from "node:fs";
import path from "node:path";

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function loadProjectSpec(root = process.cwd()) {
  const file = path.join(root, "PROJECT_SPEC.json");
  if (!fs.existsSync(file)) throw new Error(`Missing PROJECT_SPEC.json: ${file}`);
  const spec = readJson(file);
  if (!spec.title?.trim()) throw new Error("PROJECT_SPEC.title is required");
  if (!Array.isArray(spec.source?.chapters) || spec.source.chapters.length === 0) {
    throw new Error("PROJECT_SPEC.source.chapters must contain at least one chapter");
  }
  // Image generation: any OpenAI-compatible Images API. Endpoint and key live in
  // the environment / .env, never in this file.
  const image = spec.imageGeneration ?? {};
  const imageProviders = new Set(["openai-compatible", "built-in-imagegen"]);
  if (!imageProviders.has(image.provider ?? "openai-compatible")) {
    throw new Error("PROJECT_SPEC.imageGeneration.provider must be openai-compatible or built-in-imagegen");
  }
  const concurrency = image.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("PROJECT_SPEC.imageGeneration.concurrency must be an integer from 1 to 32");
  }
  const candidates = image.candidates ?? 1;
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 8) {
    throw new Error("PROJECT_SPEC.imageGeneration.candidates must be an integer from 1 to 8");
  }
  if (image.size !== undefined && !/^\d{3,5}x\d{3,5}$/.test(image.size)) {
    throw new Error("PROJECT_SPEC.imageGeneration.size must look like 1152x2048");
  }
  for (const secret of ["apiKey", "key", "token", "baseUrl", "endpoint"]) {
    if (image[secret] !== undefined) throw new Error(`PROJECT_SPEC.imageGeneration.${secret} must not be stored in the project; use .env`);
  }

  // Motion: optional local image-to-video engine. Absent means static zoom/pan only.
  const video = spec.video;
  if (video !== undefined) {
    if (video.engine !== undefined && video.engine !== "comfyui-h3") throw new Error("PROJECT_SPEC.video.engine must be comfyui-h3");
    for (const key of ["width", "height"]) {
      if (video[key] !== undefined && (!Number.isInteger(video[key]) || video[key] % 32 !== 0)) throw new Error(`PROJECT_SPEC.video.${key} must be an integer multiple of 32`);
    }
  }

  // Narration engine: edge (default) or a user-supplied command.
  const engine = spec.narration?.engine ?? "edge";
  if (!new Set(["edge", "command"]).has(engine)) throw new Error("PROJECT_SPEC.narration.engine must be edge or command");
  return spec;
}
export function toChineseNumber(value) {
  if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error(`chapter number out of range: ${value}`);
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? "" : digits[tens]}十${ones === 0 ? "" : digits[ones]}`;
}

export function projectRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export function assertProjectFile(root, relative, label = "project asset") {
  if (!relative) throw new Error(`${label} path is required`);
  const absolute = path.resolve(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  return absolute;
}
