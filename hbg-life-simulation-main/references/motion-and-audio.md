# Motion, dialogue, and audio

`scripts/animate_shots.mjs` sends every storyboard still to ComfyUI running the MiniMax-H3 image-to-video workflow. H3 generates picture and sound together, so a clip can carry lip-synced dialogue or ambience without a separate lip-sync tool.

## Configuration

Endpoints: `COMFY_URLS` in `.env` (comma list; one render runs per instance, so two GPUs with one instance each render two clips in parallel).

`PROJECT_SPEC.json → video` (all optional):

```json
"video": {
  "engine": "comfyui-h3",
  "unet": "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
  "steps": 8,
  "lora": "",
  "width": 768,
  "height": 1344,
  "fps": 24,
  "minSeconds": 1.5,
  "maxSeconds": 8,
  "padSeconds": 0.25,
  "defaultAmbience": "only quiet natural ambience",
  "keepAmbience": false
}
```

`width` and `height` must be multiples of 32 and default to the canvas in `HBG_STYLE.json`. Frame counts snap to H3's `17k+5` grid (for example 56, 107, 124). Each scene's seed is derived from its id, so reruns are repeatable.

Choose the model by speed and VRAM. A distilled 8-step model needs no LoRA; a base model with a turbo LoRA uses `lora` and the LoRA's step count.

## Scene fields

```json
{
  "id": "s014",
  "asset": "assets/generated/scenes/s014.png",
  "duration": 3.2,
  "motionPrompt": "镜头缓慢推近，男人转头看向屏幕，灯光轻微闪烁",
  "dialogue": { "speaker": "lu", "text": "各位老铁，今天这场直播，我只演示一件事。" },
  "voice": "a calm young adult male voice",
  "ambience": "faint night insects"
}
```

- `duration` comes from real timing. The clip is rendered a little longer (`padSeconds`) and trimmed; if it is still shorter the last frame is held.
- Without `dialogue`, the prompt asks for ambience only and forbids speech, singing, and music. Without that sentence the model tends to invent background singing or music.
- With `dialogue`, the line is quoted in Mandarin Chinese in the prompt together with a voice description. The clip's own sound is kept in the final mix. A faster-whisper transcription of a tested clip matched the written line almost word for word.
- `keepAudio: true` on a scene keeps the clip's ambience; `video.keepAmbience: true` keeps ambience for every clip. By default only dialogue clips keep their sound and other scenes are silent under the BGM/narration.

## Rules that matter

1. Keep lines short: one sentence per clip. Long speech needs several scenes.
2. Use the same `voice` description for the same character everywhere. The image-to-video node has no voice reference, so timbre can still drift between clips; for a narrator or a fixed protagonist voice, generate the line with a TTS engine instead (`narration.engine: command`) and leave the clip silent.
3. Describe motion, not appearance. The first frame already fixes identity and scene.
4. Never request on-screen text or subtitles in the prompt; captions are burned in later.
5. Sample a new batch first: extract start/middle/end frames, check hands and face, and transcribe the audio before queueing a whole episode.

## Measuring speed

`manifest.json` in `assets/generated/clips/` records frames, `renderSeconds`, and the instance per clip. Compute seconds of GPU time per output second from it and re-plan the schedule from real numbers. A tested setup (768×1344, 8-step distilled model, one 46 GB GPU) took about 50 s of GPU time per output second after warm-up, plus a one-time model load.

## Final mix

`render_streaming_ffmpeg.mjs` builds each scene segment from its clip (scaled and cropped to the canvas, last frame held if short, trimmed to the scene), keeps the clip's sound only where configured, and mixes it with narration and BGM. Scenes without a clip fall back to the deterministic zoom/pan over the still.
