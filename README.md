# SalonReel

Upload a finished-hairstyle video, get an AI read of the look, generate promo copy, render a real 1080×1920 Reel, and publish it to Instagram.

## Run
Requires Node 18+ and ffmpeg/ffprobe (with libass) on PATH.
```bash
cd salonreel
npm install
cp .env.example .env   # fill in keys (optional — runs in demo mode without them)
npm start              # http://localhost:3000
```
If keys are missing, the app runs in **demo mode** and shows a banner. In demo mode the analysis and copy are mock data, nothing is sent to Instagram, and video upload and ffmpeg rendering are still real.

## Pipeline
| Step | Endpoint | What it does |
|---|---|---|
| Upload | `POST /api/upload` (multipart `video`) / `POST /api/sample` | Stores the clip in `data/uploads`. The sample clip is generated with ffmpeg |
| Analyze | `POST /api/analyze {videoId}` | ffmpeg extracts 6 evenly spaced keyframes, which go to Grok or Claude vision. Returns JSON: cut, color, length, technique, tags, standout details, confidence |
| Copy | `POST /api/generate {look,tone,salon}` | Uses the LLM to write script lines, a caption, and hashtags for the chosen tone (Luxe/Fun/Minimal) |
| Render | `POST /api/render {videoId,lines,salon,track,per,tone}` | ffmpeg renders a 9:16 1080×1920 H.264/AAC MP4 with burned-in timed captions (ASS), a salon-name overlay, and music mixed under the original audio. Output goes to `/renders/<id>.mp4` |
| Publish | `POST /api/publish {renderId,caption,when?}` | Instagram Graph API steps: create a `REELS` container from `video_url`, poll `status_code` until FINISHED, then call `media_publish`. If `when` is in the future, the post is queued in `data/scheduled.json` and the server publishes it at that time; the server must be running then |

Music tracks are **placeholders synthesized by ffmpeg** (`data/music/*.m4a`), so they're royalty-free. To use licensed audio, swap in your own files and add them to `TRACKS` in `server.js`.

## Getting keys
- **XAI_API_KEY**: https://console.x.ai → API Keys. Set `XAI_MODEL` to an xAI model that accepts image input (check the current list at https://docs.x.ai).
- **ANTHROPIC_API_KEY**: https://console.anthropic.com → API Keys. Set `LLM_PROVIDER=claude`.
- **Instagram** (needs an Instagram Business or Creator account linked to a Facebook Page):
  1. Create an app at https://developers.facebook.com and add the *Instagram Graph API* product.
  2. Request `instagram_basic`, `instagram_content_publish`, `pages_show_list`, and `pages_read_engagement`.
  3. In Graph API Explorer, generate a user token, then exchange it for a long-lived token → `IG_ACCESS_TOKEN`.
  4. `GET /me/accounts`, then `GET /{page-id}?fields=instagram_business_account`. The returned id is `IG_USER_ID`.
- **PUBLIC_BASE_URL**: a public HTTPS URL for this server, so Instagram can fetch the MP4. Examples are a deployed host, `cloudflared tunnel --url http://localhost:3000`, or ngrok.

## Notes
- Only the first 90s of a clip are rendered, which is the Reels limit.
- The scheduler polls every 30s. Instagram's API has no native Reels scheduling, so the server does the scheduling.
- MVP: Instagram auto-publish is disabled; the final step is Download + Copy caption. Set ENABLE_IG_PUBLISH=1 to re-enable the dormant Graph API code.

## AI script pipeline
- **Vision** (`/api/analyze`): samples 6–12 frames at known timestamps and returns `has_haircut`, `confidence`, look fields, and a timestamped `clip_breakdown` of `[{start_s,end_s,what_is_visible}]`. If confidence is below 0.4, the result is treated as no haircut.
- **Script** (`/api/generate`): sends the prompt in `prompts/script_prompt.txt`, the salon profile (brand notes, stylist, services, booking text, city, language), and fixed rules: return `{"error":"no_haircut"}` when there is no haircut, no emoji in script lines, and timed lines that don't overlap. The server checks the output, clamps the times, and strips emoji.
- **Render**: burns in each caption at its own `start_s`–`end_s`.
- The salon profile is saved in the browser's localStorage, one profile per salon name.
