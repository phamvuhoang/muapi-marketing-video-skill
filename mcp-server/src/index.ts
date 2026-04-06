#!/usr/bin/env node
/**
 * MuAPI Video Marketing MCP Server
 * Exposes MuAPI generative media tools to Claude Code CLI and Claude Desktop.
 *
 * Tools exposed:
 *   muapi_generate_image    — Text-to-image via Flux Dev / Midjourney
 *   muapi_image_to_video    — Animate a static image into a video clip
 *   muapi_generate_video    — Text-to-video (no source image required)
 *   muapi_create_music      — Generate background music via Suno V5
 *   muapi_lipsync           — Sync video lip movement to audio
 *   muapi_video_effects     — Apply Wan AI cinematic effects
 *   muapi_upload_file       — Upload local file → CDN URL
 *   muapi_poll_result       — Poll async task by request_id
 *   muapi_run_workflow      — Execute a saved MuAPI workflow
 *   muapi_list_workflows    — Discover available workflows
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.MUAPI_API_KEY || "";
const BASE_URL = "https://api.muapi.ai";
const POLL_TIMEOUT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 3_000;  // 3 seconds

if (!API_KEY) {
  console.error(
    "[muapi-mcp] WARNING: MUAPI_API_KEY not set. Set it in your environment:\n" +
    "  export MUAPI_API_KEY=your_key_here\n" +
    "  Get yours at https://muapi.ai/dashboard"
  );
}

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

interface ApiResponse {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

async function muapiPost(
  endpoint: string,
  body: Record<string, unknown>
): Promise<ApiResponse> {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MuAPI ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<ApiResponse>;
}

async function muapiGet(endpoint: string): Promise<ApiResponse> {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": API_KEY },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MuAPI ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<ApiResponse>;
}

async function muapiUploadFile(filePath: string): Promise<{ url: string }> {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const fileBuffer = fs.readFileSync(absolutePath);
  const fileName = path.basename(absolutePath);
  const mimeType = guessMimeType(fileName);

  // Use FormData for multipart upload
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", fileBuffer, {
    filename: fileName,
    contentType: mimeType,
  });

  const url = `${BASE_URL}/api/v1/upload_file`;

  return new Promise((resolve, reject) => {
    const formHeaders = form.getHeaders();
    const options = {
      method: "POST",
      headers: {
        ...formHeaders,
        "x-api-key": API_KEY,
      },
    };

    const protocol = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: options.headers,
    };

    const req = protocol.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.url) {
            resolve({ url: parsed.url });
          } else {
            reject(new Error(`Upload failed: ${data}`));
          }
        } catch {
          reject(new Error(`Failed to parse upload response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    form.pipe(req);
  });
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  };
  return map[ext] || "application/octet-stream";
}

// ─── Poll Helper ─────────────────────────────────────────────────────────────

async function pollUntilDone(
  requestId: string,
  timeoutMs = POLL_TIMEOUT_MS
): Promise<ApiResponse> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await muapiGet(`/api/v1/predictions/${requestId}/result`);
    const data = result.data as Record<string, unknown> | undefined;
    const status = data?.status ?? result.status as string;

    if (status === "completed") return result;
    if (status === "failed") {
      throw new Error(`Task failed: ${data?.error ?? JSON.stringify(result)}`);
    }

    // Still processing — wait and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Task ${requestId} timed out after ${timeoutMs / 1000}s`);
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "muapi_generate_image",
    description:
      "Generate a high-quality image from a text prompt using Flux Dev (12B parameter model). " +
      "Returns a request_id for async polling. Use muapi_poll_result to get the image URL.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed text prompt. Be specific about style, lighting, composition, colors. " +
            "Example: 'A premium Vietnamese coffee brand product shot, sleek matte black packaging, " +
            "golden logo, bokeh background of Hanoi street, photorealistic, 8k'",
        },
        size: {
          type: "string",
          description:
            "Output dimensions. Landscape: '1344*768', Portrait/TikTok: '768*1344', Square: '1024*1024'",
          default: "1344*768",
        },
        num_inference_steps: {
          type: "number",
          description: "Quality steps: 20 (fast/draft) to 50 (best quality). Default: 28",
          default: 28,
        },
        guidance_scale: {
          type: "number",
          description: "Prompt adherence: 1 (creative) to 20 (strict). Default: 3.5",
          default: 3.5,
        },
        seed: {
          type: "number",
          description:
            "Fixed seed for reproducible output. Use -1 for random. " +
            "Use same seed across scenes for visual consistency.",
          default: -1,
        },
        num_images: {
          type: "number",
          description: "How many image variants to generate. Default: 1",
          default: 1,
        },
        wait_for_result: {
          type: "boolean",
          description:
            "If true, polls automatically and returns the final image URL. " +
            "If false, returns request_id immediately for manual polling. Default: true",
          default: true,
        },
      },
      required: ["prompt"],
    },
  },

  {
    name: "muapi_image_to_video",
    description:
      "Animate a static image into a short video clip. Core tool for marketing video production. " +
      "Takes an image URL (from muapi_generate_image or CDN) and returns a video clip.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description:
            "Public URL of the source image. Must be accessible. " +
            "For local files, use muapi_upload_file first.",
        },
        prompt: {
          type: "string",
          description:
            "Motion description. Example: 'slow cinematic zoom in, gentle parallax, professional product reveal'",
        },
        model: {
          type: "string",
          description:
            "Video model: 'kling-pro' (best realism, slow), 'kling-standard' (balanced), " +
            "'minimax-pro' (dynamic motion), 'runway-gen3' (artistic), 'wan-2.1' (high fidelity). " +
            "Default: 'kling-pro'",
          default: "kling-pro",
        },
        duration: {
          type: "number",
          description: "Clip duration in seconds. Typically 5 or 10. Default: 5",
          default: 5,
        },
        aspect_ratio: {
          type: "string",
          description: "'16:9' (landscape/YouTube), '9:16' (TikTok/Reels), '1:1' (Instagram square). Default: '16:9'",
          default: "16:9",
        },
        wait_for_result: {
          type: "boolean",
          description: "Auto-poll and return final video URL. Default: true",
          default: true,
        },
      },
      required: ["image_url", "prompt"],
    },
  },

  {
    name: "muapi_generate_video",
    description:
      "Generate a video directly from a text prompt (no source image). " +
      "Good for abstract content, effects, or when no brand imagery exists.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed video prompt including motion, style, atmosphere. " +
            "Example: 'A coffee bean falling into a cup in slow motion, steam rising, warm amber tones, product ad'",
        },
        model: {
          type: "string",
          description:
            "Model: 'minimax-pro' (default), 'kling-pro', 'wan-2.1', 'veo3'. Default: 'minimax-pro'",
          default: "minimax-pro",
        },
        duration: {
          type: "number",
          description: "Duration in seconds. Typically 5–10. Default: 5",
          default: 5,
        },
        aspect_ratio: {
          type: "string",
          description: "'16:9' | '9:16' | '1:1'. Default: '16:9'",
          default: "16:9",
        },
        wait_for_result: {
          type: "boolean",
          default: true,
        },
      },
      required: ["prompt"],
    },
  },

  {
    name: "muapi_create_music",
    description:
      "Generate background music or sound effects for marketing videos using Suno V5. " +
      "Returns a music track URL. Specify genre, mood, and avoid vocals for background use.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Music description. Examples: " +
            "'upbeat corporate electronic, energetic brand reveal, no vocals, 30 seconds' | " +
            "'Vietnamese lo-fi hip hop, café ambiance, chill urban, instrumental' | " +
            "'cinematic orchestral, luxury brand, aspirational, strings and piano'",
        },
        style: {
          type: "string",
          description:
            "Music style tags (comma-separated). Defaults to the prompt if not set. " +
            "Examples: 'edm, electronic, no vocals' | 'orchestral, cinematic' | 'lo-fi, chill, instrumental'",
        },
        duration: {
          type: "number",
          description:
            "Track length in seconds. Match to total video duration + 5s for fade. Default: 35",
          default: 35,
        },
        model: {
          type: "string",
          description:
            "Music model version. Options: 'V5' (default), 'V4_5', 'V4', 'V3_5'. Default: 'V5'",
          default: "V5",
        },
        wait_for_result: {
          type: "boolean",
          default: true,
        },
      },
      required: ["prompt"],
    },
  },

  {
    name: "muapi_lipsync",
    description:
      "Synchronize a video character's lip movements to an audio track. " +
      "Use when the video has a spokesperson and you have voiceover audio.",
    inputSchema: {
      type: "object",
      properties: {
        video_url: {
          type: "string",
          description: "URL of the source video (with a face/character to animate)",
        },
        audio_url: {
          type: "string",
          description: "URL of the audio track (voiceover, speech)",
        },
        model: {
          type: "string",
          description:
            "'sync-lipsync' (highest fidelity), 'latentsync' (faster), " +
            "'creatify-lipsync' (content creator style), 'veed-lipsync' (professional). Default: 'sync-lipsync'",
          default: "sync-lipsync",
        },
        wait_for_result: {
          type: "boolean",
          default: true,
        },
      },
      required: ["video_url", "audio_url"],
    },
  },

  {
    name: "muapi_video_effects",
    description:
      "Apply cinematic AI effects to a video or image. " +
      "Effects include VHS, Film Noir, Samurai It, Cakeify, Inflate It, and more. " +
      "Great for creative social media content.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description: "URL of the source image or video frame",
        },
        prompt: {
          type: "string",
          description:
            "Effect description or instruction. Example: 'cinematic lens flare, warm color grade'",
        },
        effect_name: {
          type: "string",
          description:
            "Pretrained effect name. Options: 'VHS Footage', 'Samurai It', 'Film Noir', " +
            "'Inflate It', 'Cakeify', 'Assassin'. Leave empty to use prompt only.",
        },
        aspect_ratio: {
          type: "string",
          description: "'16:9' | '9:16' | '1:1'. Default: '16:9'",
          default: "16:9",
        },
        resolution: {
          type: "string",
          description: "'480p' or '720p'. Default: '720p'",
          default: "720p",
        },
        quality: {
          type: "string",
          description: "'medium' or 'high'. Default: 'high'",
          default: "high",
        },
        duration: {
          type: "number",
          description: "Output duration in seconds. 5–10. Default: 5",
          default: 5,
        },
        wait_for_result: {
          type: "boolean",
          default: true,
        },
      },
      required: ["image_url", "prompt"],
    },
  },

  {
    name: "muapi_upload_file",
    description:
      "Upload a local file (image, video, or audio) to the MuAPI CDN. " +
      "Returns a public URL usable in all other muapi_ tools. " +
      "Use this when the user provides a local file path instead of a URL.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Absolute or relative path to the local file. " +
            "Example: '/Users/henry/brand-assets/logo.png' or './product-photo.jpg'",
        },
      },
      required: ["file_path"],
    },
  },

  {
    name: "muapi_poll_result",
    description:
      "Poll for the result of any async MuAPI generation task. " +
      "Use this when you have a request_id from any other muapi_ tool called with wait_for_result=false.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          type: "string",
          description: "The request_id returned by a generation tool",
        },
        wait_for_completion: {
          type: "boolean",
          description:
            "If true, blocks until task completes (up to 5 minutes). " +
            "If false, returns current status immediately. Default: true",
          default: true,
        },
      },
      required: ["request_id"],
    },
  },

  {
    name: "muapi_run_workflow",
    description:
      "Execute a saved MuAPI workflow (multi-node AI pipeline). " +
      "Workflows can chain image gen → upscale → video → music in one call.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The workflow ID from muapi_list_workflows or the MuAPI dashboard",
        },
        inputs: {
          type: "object",
          description:
            "Key-value inputs matching the workflow's input schema. " +
            "Example: { 'prompt': 'coffee ad', 'style': 'cinematic' }",
        },
        webhook_url: {
          type: "string",
          description: "Optional URL to receive completion notification",
        },
      },
      required: ["workflow_id", "inputs"],
    },
  },

  {
    name: "muapi_list_workflows",
    description:
      "List all available saved MuAPI workflows for this account. " +
      "Use this to discover what automated pipelines exist before running muapi_run_workflow.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleGenerateImage(
  args: Record<string, unknown>
): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: args.prompt,
    size: args.size ?? "1344*768",
    num_inference_steps: args.num_inference_steps ?? 28,
    guidance_scale: args.guidance_scale ?? 3.5,
    seed: args.seed ?? -1,
    num_images: args.num_images ?? 1,
  };

  const result = await muapiPost("/api/v1/flux-dev-image", body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.id as string) ||
    (data?.request_id as string) ||
    (result.id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      image_url: outputs?.[0] ?? null,
      all_outputs: outputs ?? [],
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

async function handleImageToVideo(
  args: Record<string, unknown>
): Promise<string> {
  const body: Record<string, unknown> = {
    image_url: args.image_url,
    prompt: args.prompt ?? "",
    model: args.model ?? "kling-pro",
    duration: args.duration ?? 5,
    aspect_ratio: args.aspect_ratio ?? "16:9",
  };

  // Route to the correct endpoint based on model
  const model = (args.model as string) ?? "kling-pro";
  let endpoint = "/api/v1/kling-image-to-video";
  if (model.startsWith("minimax")) endpoint = "/api/v1/minimax-image-to-video";
  else if (model.startsWith("runway")) endpoint = "/api/v1/runway-image-to-video";
  else if (model.startsWith("wan")) endpoint = "/api/v1/wan-image-to-video";

  const result = await muapiPost(endpoint, body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.id as string) ||
    (data?.request_id as string) ||
    (result.request_id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    const videoUrl =
      outputs?.[0] ??
      (final.video as Record<string, string>)?.url ??
      null;
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      video_url: videoUrl,
      all_outputs: outputs ?? [],
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

async function handleGenerateVideo(
  args: Record<string, unknown>
): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: args.prompt,
    model: args.model ?? "minimax-pro",
    duration: args.duration ?? 5,
    aspect_ratio: args.aspect_ratio ?? "16:9",
  };

  const result = await muapiPost("/api/v1/generate-video", body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.id as string) ||
    (data?.request_id as string) ||
    (result.request_id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      video_url: outputs?.[0] ?? null,
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

// Map friendly model aliases to the API's expected values
const SUNO_MODEL_MAP: Record<string, string> = {
  "suno-v5":   "V5",
  "suno-v4.5": "V4_5",
  "suno-v4":   "V4",
  "suno-v3.5": "V3_5",
  "V5":        "V5",
  "V4_5":      "V4_5",
  "V4_5PLUS":  "V4_5PLUS",
  "V4_5ALL":   "V4_5ALL",
  "V4":        "V4",
  "V3_5":      "V3_5",
  "V5_5":      "V5_5",
};

async function handleCreateMusic(
  args: Record<string, unknown>
): Promise<string> {
  const rawModel = (args.model as string) ?? "V5";
  const resolvedModel = SUNO_MODEL_MAP[rawModel] ?? "V5";
  const body: Record<string, unknown> = {
    prompt: args.prompt,
    style: args.style ?? args.prompt,  // style is required by the API; fall back to prompt
    duration: args.duration ?? 35,
    model: resolvedModel,
  };

  const result = await muapiPost("/api/v1/suno-create-music", body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.id as string) ||
    (data?.request_id as string) ||
    (result.request_id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    const audioUrl =
      outputs?.[0] ??
      (final.audio as Record<string, string>)?.url ??
      null;
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      audio_url: audioUrl,
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

async function handleLipsync(
  args: Record<string, unknown>
): Promise<string> {
  const modelEndpointMap: Record<string, string> = {
    "sync-lipsync": "/api/v1/sync-lipsync",
    "latentsync": "/api/v1/latentsync-video",
    "creatify-lipsync": "/api/v1/creatify-lipsync",
    "veed-lipsync": "/api/v1/veed-lipsync",
  };

  const model = (args.model as string) ?? "sync-lipsync";
  const endpoint = modelEndpointMap[model] ?? "/api/v1/sync-lipsync";

  const body: Record<string, unknown> = {
    video_url: args.video_url,
    audio_url: args.audio_url,
  };

  const result = await muapiPost(endpoint, body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.id as string) ||
    (data?.request_id as string) ||
    (result.request_id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      video_url: outputs?.[0] ?? null,
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

async function handleVideoEffects(
  args: Record<string, unknown>
): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: args.prompt,
    image_url: args.image_url,
    name: args.effect_name ?? "",
    aspect_ratio: args.aspect_ratio ?? "16:9",
    resolution: args.resolution ?? "720p",
    quality: args.quality ?? "high",
    duration: args.duration ?? 5,
  };

  const result = await muapiPost("/api/v1/generate_wan_ai_effects", body);
  const data = result.data as Record<string, unknown>;
  const requestId =
    (data?.request_id as string) ||
    (data?.id as string) ||
    (result.request_id as string);

  if (!requestId) {
    return JSON.stringify({ error: "No request_id returned", raw: result });
  }

  if (args.wait_for_result !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[];
    const videoUrl =
      outputs?.[0] ??
      (final.video as Record<string, string>)?.url ??
      null;
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      video_url: videoUrl,
    });
  }

  return JSON.stringify({ status: "submitted", request_id: requestId });
}

async function handleUploadFile(
  args: Record<string, unknown>
): Promise<string> {
  const filePath = args.file_path as string;
  const result = await muapiUploadFile(filePath);
  return JSON.stringify({
    status: "uploaded",
    url: result.url,
    original_path: filePath,
  });
}

async function handlePollResult(
  args: Record<string, unknown>
): Promise<string> {
  const requestId = args.request_id as string;

  if (args.wait_for_completion !== false) {
    const final = await pollUntilDone(requestId);
    const finalData = final.data as Record<string, unknown>;
    const outputs = (finalData?.outputs ?? final.outputs) as string[] | undefined;
    return JSON.stringify({
      status: "completed",
      request_id: requestId,
      outputs: outputs ?? [],
      primary_output: outputs?.[0] ?? null,
      raw: final,
    });
  }

  const result = await muapiGet(`/api/v1/predictions/${requestId}/result`);
  return JSON.stringify(result);
}

async function handleRunWorkflow(
  args: Record<string, unknown>
): Promise<string> {
  const workflowId = args.workflow_id as string;
  const body: Record<string, unknown> = {
    inputs: args.inputs ?? {},
  };
  if (args.webhook_url) {
    body.webhook_url = args.webhook_url;
  }

  const result = await muapiPost(`/api/workflow/${workflowId}/run`, body);
  return JSON.stringify(result);
}

async function handleListWorkflows(): Promise<string> {
  const result = await muapiGet("/api/workflow/list");
  return JSON.stringify(result);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "muapi-video-marketing",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;

    switch (name) {
      case "muapi_generate_image":
        result = await handleGenerateImage(args as Record<string, unknown>);
        break;
      case "muapi_image_to_video":
        result = await handleImageToVideo(args as Record<string, unknown>);
        break;
      case "muapi_generate_video":
        result = await handleGenerateVideo(args as Record<string, unknown>);
        break;
      case "muapi_create_music":
        result = await handleCreateMusic(args as Record<string, unknown>);
        break;
      case "muapi_lipsync":
        result = await handleLipsync(args as Record<string, unknown>);
        break;
      case "muapi_video_effects":
        result = await handleVideoEffects(args as Record<string, unknown>);
        break;
      case "muapi_upload_file":
        result = await handleUploadFile(args as Record<string, unknown>);
        break;
      case "muapi_poll_result":
        result = await handlePollResult(args as Record<string, unknown>);
        break;
      case "muapi_run_workflow":
        result = await handleRunWorkflow(args as Record<string, unknown>);
        break;
      case "muapi_list_workflows":
        result = await handleListWorkflows();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[muapi-mcp] Server started on stdio. Tools: " + TOOLS.map((t) => t.name).join(", "));
}

main().catch((err) => {
  console.error("[muapi-mcp] Fatal error:", err);
  process.exit(1);
});
