# Image generation

## Channel

Use any OpenAI-compatible Images API through `scripts/gen_images.mjs`. Configuration is environment-only:

| Variable | Meaning |
|---|---|
| `IMAGE_API_BASE_URL` | API root, for example `https://provider.example/v1` |
| `IMAGE_API_KEY` | Secret. Only in `.env` or the process environment |
| `IMAGE_MODEL` | Model name, for example `gpt-image-2` |
| `IMAGE_SIZE` | Requested size, for example `1152x2048` for 9:16 |
| `IMAGE_CONCURRENCY` | Parallel requests, default 5 (1–32) |
| `IMAGE_CANDIDATES` | Candidates per job, default 1 |

Fall back to the built-in `imagegen` tool only when no API is configured. Never write the endpoint, key, or any token into the project, prompts, logs, `PROMPTS.md`, or a report.

## Reference images

A job may carry `references` (project-relative paths). The script then calls `/images/edits` as multipart, sending one reference as `image` and several as `image[]` (up to 10 on the provider tested). Make one anchor image per hero, key prop, and main location first, then pass the relevant anchors to every scene that needs them, and restate the immutable traits in the prompt. A two-reference test (hero + courtyard) kept the face, hairstyle, and costume and merged the background correctly.

## Size and ratio

Some providers prefer `aspect_ratio` (and `size_tier`) over a pixel size. Set `IMAGE_ASPECT_RATIO=9:16` to send the ratio instead of `size`; add `IMAGE_SIZE_TIER` only if the model offers that tier (the model tested only had 1k and rejected `2k`).

## Size

Providers often deliver a nearby size instead of the requested one. One provider tested with portrait requests returned about 941×1672 for `1152x2048`, `1080x1920`, and `864x1536`, and 948×1659 for `1024x1792`. Request the exact target aspect ratio (9:16 → `1152x2048`) and let the script scale and crop to the canvas. Do not trust the requested size as the delivered size.

## Batch workflow

1. Write `assets/generated/prompts/jobs.jsonl`, one job per line:
   `{"id":"s001","prompt":"...","size":"1152x2048","candidates":3}`.
2. Dry-run: `node scripts/gen_images.mjs PROJECT_DIR --dry-run`.
3. Test one scene first: `--only s001`.
4. Run the batch. Existing candidates are skipped, so an interrupted run resumes. Use `--only id1,id2` to redo specific scenes after deleting their candidates.
5. Candidates land in `assets/generated/candidates/<id>_<k>.png`; candidate 1 is copied to `assets/generated/scenes/<id>.png` when no scene image exists. Choose the best candidate and overwrite the scene file.
6. Attempts are logged to `assets/generated/prompts/gen_log.jsonl` (id, candidate, model, size, ok/error, milliseconds), never the key.

The image host may reject non-browser User-Agents; the script sends a browser User-Agent when downloading images.

## Prompt rules

- Specify the exact number of visible people and which characters are allowed; add `No other person may appear` for identity-critical and high-risk frames.
- Repeat immutable identity traits from `CHARACTERS.md` in every prompt. Do not paste the whole supporting cast into every prompt.
- Require no text, captions, speech bubbles, logos, or watermarks.
- Generate high-risk frames (hand close-ups, overlapping limbs, phone orientation, tool contact, identity-critical hero shots) as standalone images, never as grid panels.
- For 2×2 sheets (optional, only for low-risk related beats): four equal panels, uniform black gutters; map jobs to scene IDs in `SHEET_MAP.json` and split with `scripts/split_2x2.sh`.

## Inspection

Build a contact sheet (`scripts/make_contact_sheet.sh`) and inspect identity, anatomy, phone direction, hands, tools, panel count, and unexpected people. Regenerate only failed scenes. Record successful jobs, failed attempts, model, size, and concurrency in `PROMPTS.md`.
