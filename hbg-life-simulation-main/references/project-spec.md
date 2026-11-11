# Project specification

Use `PROJECT_SPEC.json` for every value that changes with the story. Builders must never contain a story title, fixed chapter count, character identity, correction list, voice choice, BGM filename, flash-life list, or selected-life image path.

Required shape:

```json
{
  "version": 1,
  "title": "完整的人生副本名称",
  "titleLines": ["标题第一行", "标题第二行"],
  "source": {
    "openingSentence": "今天体验的人生副本是完整的人生副本名称。",
    "corrections": [{ "from": "明显错词", "to": "修正后" }],
    "chapters": [{ "title": "章节名", "cue": "本章在正文中唯一的开头短语" }]
  },
  "narration": {
    "engine": "edge",
    "voice": "zh-CN-YunjianNeural",
    "bodyRate": "+0%",
    "leadRate": "+0%",
    "revealRate": "+0%",
    "pitch": "+0Hz",
    "flashDuration": 1.667,
    "captionMaxChars": 18,
    "captionMinChars": 6,
    "captionMinDuration": 0.55
  },
  "imageGeneration": {
    "provider": "openai-compatible",
    "model": "gpt-image-2",
    "size": "1152x2048",
    "concurrency": 5,
    "candidates": 2
  },
  "video": {
    "engine": "comfyui-h3",
    "unet": "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
    "steps": 8,
    "fps": 24
  },
  "opening": {
    "enabled": true,
    "leadDisplayText": "今天体验的人生副本是……",
    "flashMedia": "assets/opening/flash.mp4",
    "finalImage": "assets/opening/final.jpg",
    "flashLives": [{ "asset": "assets/opening/life-01.png", "label": "另一种人生" }]
  },
  "audio": {
    "bgmSource": "assets/audio/bgm/source.mp3",
    "bgmLooped": "assets/audio/bgm/looped.m4a",
    "narrationOutput": "assets/audio/narration.m4a"
  }
}
```

Rules:

- Keep `SCRIPT_SOURCE.md` verbatim. Put only unmistakable transcription repairs in `source.corrections`.
- Use any reasonable chapter count. Builders derive headings, act labels, sub-compositions, and timing from the array length.
- Make each chapter cue unique and ordered after corrections.
- Keep character identity in `CHARACTERS.md`, not in this shared specification or a builder.
- `imageGeneration.provider` is `openai-compatible` (default) or `built-in-imagegen`. Record model, size, concurrency, and candidates only. The loader rejects `apiKey`, `key`, `token`, `baseUrl`, and `endpoint` here: those belong in `.env`. Keep concurrency within 1–32.
- `video` is optional. Without it only static zoom/pan is available. See [motion-and-audio.md](motion-and-audio.md) for every field.
- `narration.engine` is `edge` or `command`. A command engine needs `narration.command`, a shell template that reads `{txt}` and writes `{wav}` and `{vtt}`; `{voice}` and `{rate}` are substituted too. The VTT is the master timeline.
- Set `opening.enabled` to `false` to skip the HBG flash opening ([opening-system.md](opening-system.md)).
- Keep orientation-dependent pixels in `HBG_STYLE.json`, never in `PROJECT_SPEC.json`.
- Keep semantic scene selection in `STORYBOARD_BASE.json`; code may validate it but must not invent example-specific beats.
- Use `captionMaxChars=18` as the usual landscape ceiling and `14` as the usual portrait ceiling. Generated splits must meet `captionMinChars`; only a complete original utterance may set the short-caption exception.
- Record missing punctuation before a spoken list or a broken source phrase in `source.corrections`. Do not use source line breaks as synthetic TTS pauses.
- Resolve every `opening.flashLives[].asset` to the exact orientation canvas before validation.
- Resolve or copy every configured asset into the project before composition building.
