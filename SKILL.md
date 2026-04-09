---
name: muapi-video-marketing
description: >
  Create AI-generated marketing videos using MuAPI's generative media APIs.
  Handles the complete pipeline: creative brief → storyboard → image generation →
  video animation → background music → optional lipsync.
  Use this skill for: marketing videos, product promos, social media clips (TikTok/Reels/YouTube),
  brand videos, AI-generated video content, or any request to produce videos with AI.
---

# MuAPI Video Marketing Skill

Orchestrates AI-powered marketing video production via MuAPI's REST APIs and MCP tools.

## Quick Start

1. **Have your MuAPI API key?** Get one at https://muapi.ai/dashboard
2. **MCP server running?** Start with: `npx ts-node mcp-server/src/index.ts`
3. **Ready to create?** Describe your video idea and this skill will handle:
   - Storyboarding your concept
   - Generating high-quality images
   - Animating them into video clips
   - Creating background music
   - Delivering all assets

See Prerequisites section below for detailed setup.

---

## Prerequisites

User must have:
1. MuAPI API key from https://muapi.ai/dashboard
2. MCP server running: `npx ts-node mcp-server/src/index.ts` (or built version)
3. `MUAPI_API_KEY` set in environment

If the MCP server is not set up, direct the user to `README.md` for one-command setup.

---

## Pipeline Overview

```
Brief → Storyboard → Images (Flux Dev) → Videos (Image-to-Video) → Music (Suno) → [Lipsync] → Delivery
```

Each stage is a discrete MCP tool call. Stages can be run independently.

---

## Stage 1 — Creative Brief & Storyboard

**Claude's job:** Generate the storyboard from the user's brief. No tool call needed.

Produce a JSON storyboard with this structure:

```json
{
  "title": "Campaign title",
  "brand": "Brand name",
  "target_audience": "Description",
  "tone": "energetic | professional | warm | playful | cinematic",
  "aspect_ratio": "16:9 | 9:16 | 1:1",
  "duration_per_scene": 5,
  "music_style": "upbeat corporate | cinematic orchestral | lo-fi chill | etc.",
  "scenes": [
    {
      "id": 1,
      "duration": 5,
      "image_prompt": "Detailed Flux-optimized prompt. Be specific: lighting, style, composition, colors, mood. NO text overlay in prompt.",
      "video_motion": "slow zoom in | pan left | camera orbit | gentle drift | etc.",
      "caption": "Optional on-screen text (handled separately)",
      "voiceover": "Optional voiceover script for this scene"
    }
  ]
}
```

**Storyboard guidelines:**
- 3–6 scenes for a 15–30s social clip; 6–12 scenes for a 60s+ brand video
- Image prompts: photorealistic or stylized depending on `tone`; include brand colors if known
- For 9:16 (TikTok/Reels): keep prompts vertical-composition-aware
- Motion: simple motions (zoom, pan) animate best with image-to-video models

---

## Stage 2 — Image Generation (Flux Dev)

**Tool:** `muapi_generate_image`

Call once per scene. Use async mode for parallel generation.

```typescript
// Tool input
{
  prompt: scene.image_prompt,
  size: aspect_ratio === "9:16" ? "768*1344" : aspect_ratio === "1:1" ? "1024*1024" : "1344*768",
  num_inference_steps: 28,
  guidance_scale: 3.5,
  seed: -1  // -1 for variety; fix seed for consistency across scenes
}
// Returns: { request_id, status }
```

**Poll** with `muapi_poll_result` until `status === "completed"`.  
Extract `data.outputs[0]` → image URL for next stage.

**Model selection for images:**
- `flux-dev` — default, high quality, 12B params
- `flux-schnell` — faster, lower cost, good for prototyping
- `midjourney-v7` — best aesthetics, use for premium brand work

---

## Stage 3 — Image to Video Animation

**Tool:** `muapi_image_to_video`

Animate each scene image into a short video clip.

```typescript
// Tool input
{
  image_url: scene_image_url,  // from Stage 2
  prompt: scene.video_motion + ", " + scene.image_prompt.substring(0, 100),
  model: "kling-pro",          // see model guide below
  duration: scene.duration_per_scene,
  aspect_ratio: storyboard.aspect_ratio
}
// Returns: { request_id }
```

**Poll** with `muapi_poll_result`. Extract `data.outputs[0]` → video URL.

**Video model guide:**
| Model | Best for | Quality | Speed |
|-------|----------|---------|-------|
| `kling-pro` | Realism, product shots | ★★★★★ | Slow |
| `kling-standard` | General use | ★★★★ | Medium |
| `minimax-pro` | Dynamic motion, cinematic | ★★★★★ | Medium |
| `runway-gen3` | Artistic, creative | ★★★★ | Fast |
| `wan-2.1` | High fidelity, speech | ★★★★★ | Slow |

**Default recommendation:** `kling-pro` for product/brand, `minimax-pro` for dynamic/social content.

---

## Stage 4 — Background Music

**Tool:** `muapi_create_music`

Generate one music track for the entire video.

```typescript
// Tool input
{
  prompt: storyboard.music_style + ", " + storyboard.tone + " mood, marketing background music, no vocals",
  style: storyboard.music_style + ", no vocals",  // required by API; concise style tags
  duration: total_video_duration + 5,  // extra seconds for fade
  model: "V5"  // options: "V5", "V4_5", "V4", "V3_5"
}
// Returns: { request_id }
```

**Poll** → extract audio URL.

**Music prompt examples by use case:**
- Product launch: `"upbeat electronic, energetic, modern, brand reveal feel"`
- Luxury brand: `"cinematic orchestral, elegant, aspirational, no drums"`
- Social/TikTok: `"trendy pop, punchy beat drops, high energy, viral"`
- B2B/SaaS: `"corporate ambient, clean, professional, motivational"`
- Vietnamese market: `"modern Vietnamese pop fusion, upbeat, youthful"`

---

## Stage 5 — Lipsync (Optional)

Only when user provides a voiceover recording or wants AI speech-to-video.

**Tool:** `muapi_lipsync`

```typescript
// Tool input
{
  video_url: scene_video_url,      // from Stage 3
  audio_url: voiceover_audio_url,  // user-provided or TTS-generated
  model: "sync-lipsync"            // or "latentsync" for faster inference
}
// Returns: { request_id }
```

---

## Stage 6 — Video Effects (Optional Enhancement)

Apply cinematic effects to individual clips.

**Tool:** `muapi_video_effects`

```typescript
// Tool input  
{
  image_url: scene_image_url,
  prompt: "cinematic color grade, lens flare, professional",
  name: "Film Noir" | "VHS Footage" | "Cakeify" | "Samurai It" | "Inflate It",
  aspect_ratio: storyboard.aspect_ratio,
  resolution: "720p",
  quality: "high",
  duration: 5
}
```

---

## Stage 7 — File Upload (When User Provides Local Assets)

**Tool:** `muapi_upload_file`

When user provides local images/videos/audio as file paths:

```typescript
// Tool input
{
  file_path: "/path/to/local/file.jpg",
  file_type: "image"  // "image" | "video" | "audio"
}
// Returns: { url: "https://s3.amazonaws.com/muapi-assets/..." }
```

Use the returned CDN URL in subsequent tool calls.

---

## Workflow Execution (Advanced)

For users with saved MuAPI workflows (multi-node pipelines built in the Workflow UI):

**Tool:** `muapi_run_workflow`

```typescript
// Tool input
{
  workflow_id: "wf_abc123",
  inputs: { prompt: "...", style: "..." },
  webhook_url: "optional"
}
```

Discover workflows first: use `muapi_list_workflows` to show available pipelines.

---

## Polling Pattern

All generation tasks are async. Always poll:

```typescript
// Pseudocode
let result = await muapi_poll_result({ request_id })
while (result.data.status === "processing" || result.data.status === "created") {
  await sleep(3000)  // wait 3s between polls
  result = await muapi_poll_result({ request_id })
}
if (result.data.status === "failed") throw new Error(result.data.error)
return result.data.outputs[0]  // URL of generated asset
```

Typical generation times:
- Image (Flux Dev): 10–30s
- Image-to-Video (Kling): 60–180s  
- Music (Suno): 30–60s
- Video Effects: 60–120s

---

## Complete Example Flow

User: "Create a 30-second TikTok promo for our new coffee brand Hanoi Brew — young urban vibe, Vietnamese coffee culture"

```
1. Generate storyboard: 6 scenes × 5s, 9:16, tone="vibrant street culture", music="Vietnamese lo-fi hip hop"
2. For each scene: muapi_generate_image({ prompt: "...", size: "768*1344" })
3. Poll all images (can show progress to user)
4. For each image: muapi_image_to_video({ image_url, model: "minimax-pro", duration: 5 })
5. muapi_create_music({ prompt: "Vietnamese lo-fi hip hop, chill, urban café, no vocals" })
6. Poll all videos + music
7. Report: list of 6 video clip URLs + music URL + assembly instructions
```

---

## Output to User

Always present results as:
1. **Storyboard summary** — scenes with prompts
2. **Generated assets** — image URLs, video clip URLs, music URL
3. **Assembly note** — e.g. "Use CapCut, DaVinci Resolve, or FFmpeg to merge clips and add music"
4. **Credit estimate** — rough cost indication

If user asks to assemble automatically, suggest using MuAPI Workflow system for full pipeline automation.

---

## Error Handling

| Error | Action |
|-------|--------|
| `status: "failed"` | Retry with adjusted prompt; note the exact error |
| 401 Unauthorized | Ask user to check `MUAPI_API_KEY` env var |
| 402 Insufficient credits | Direct to https://muapi.ai/dashboard to top up |
| Timeout after 300s | Suggest `--async` mode; user polls manually |
| NSFW flag | Rephrase prompt to be more conservative |

---

## References

- MuAPI docs: https://muapi.ai/docs/introduction
- Agent Skills repo: https://github.com/SamurAIGPT/Generative-Media-Skills
- Playground (model explorer): https://muapi.ai/playground
- Dashboard / API keys: https://muapi.ai/dashboard
