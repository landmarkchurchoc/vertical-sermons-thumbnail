// Nano Banana (Gemini 2.5 Flash Image) via the Google AI Studio / Generative
// Language API. Given a sermon's 16:9 horizontal thumbnail, it repositions the
// existing content into a 2:3 vertical frame — without altering the person or
// imagery — so it can be used as the sermon's vertical thumbnail.
//
// Requires a Google AI Studio API key. We accept the common env-var names so it
// works regardless of which one was set in Vercel.
import sharp from "sharp";

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

// Prompt for reflowing a 16:9 sermon graphic into a 2:3 vertical thumbnail.
// The heavy anti-duplication language is deliberate — without it the model
// sometimes tiles/stacks the layout twice to fill the taller 2:3 frame.
export const REPOSITION_PROMPT =
  "Reformat this 16:9 church sermon graphic into a SINGLE, cohesive 2:3 " +
  "vertical (portrait) thumbnail. Keep it faithful to THIS image only.\n\n" +
  "Absolute rules:\n" +
  "1. Produce ONE unified poster. NEVER tile, stack, mirror, split, repeat, or " +
  "duplicate any element. The person appears EXACTLY ONCE. Each word of the " +
  "title appears EXACTLY ONCE.\n" +
  "2. Do not change the person at all — keep the SAME person with their face, " +
  "body, hair, and clothing identical to the source. Never swap in or invent a " +
  "different person.\n" +
  "3. Keep the title text complete and legible, spelled exactly as in the " +
  "source. Never crop, cut off, abbreviate, misspell, or garble words.\n" +
  "4. Keep the source's own colors, background imagery, and visual style. " +
  "Extend that background naturally to fill the ENTIRE 2:3 frame edge to edge — " +
  "no empty, black, or letterboxed bars anywhere.\n" +
  "5. Place the title in the upper portion and the person in the lower/center; " +
  "keep text off the very bottom.\n" +
  "6. You may remove only the verse reference and the subtitle. Priority to " +
  "keep: person, title, subtitle, verse reference.\n\n" +
  "The result should read like one professionally designed vertical poster: " +
  "one subject, one headline, full-bleed background, nothing repeated.";

function geminiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_AI_STUDIO_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error(
      "Missing Google AI Studio API key (set GEMINI_API_KEY)."
    );
  }
  return key;
}

export interface ImageData {
  data: Buffer;
  mimeType: string;
}

/**
 * Reposition a 16:9 thumbnail into a 2:3 vertical image using Nano Banana.
 * Returns the generated image bytes and its mime type.
 */
export async function repositionTo2x3(input: ImageData): Promise<ImageData> {
  const key = geminiKey();
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${encodeURIComponent(key)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: REPOSITION_PROMPT },
          { inline_data: { mime_type: input.mimeType, data: input.data.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      // Force the output frame to 2:3 so the model reflows rather than crops.
      imageConfig: { aspectRatio: "2:3" },
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini image API error ${res.status}: ${detail.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    candidates?: {
      finishReason?: string;
      content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }[] };
    }[];
  };

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) {
      return {
        data: Buffer.from(inline.data, "base64"),
        mimeType: ("mimeType" in inline ? inline.mimeType : (inline as { mime_type?: string }).mime_type) || "image/png",
      };
    }
  }

  throw new Error(
    `Gemini returned no image (finishReason: ${json.candidates?.[0]?.finishReason ?? "unknown"}).`
  );
}

// Mean brightness (0-255) of the bottom ~28% of the image. Nano Banana
// sometimes letterboxes the 16:9 content into the top and leaves the bottom
// near-black; a low value here is our signal that the frame wasn't filled.
async function bottomBandBrightness(data: Buffer): Promise<number> {
  const meta = await sharp(data).metadata();
  const h = meta.height ?? 0;
  const w = meta.width ?? 0;
  if (!h || !w) return 255; // can't measure — assume fine
  const top = Math.floor(h * 0.72);
  const band = await sharp(data)
    .extract({ left: 0, top, width: w, height: h - top })
    .greyscale()
    .raw()
    .toBuffer();
  let sum = 0;
  for (const px of band) sum += px;
  return sum / band.length;
}

// Below this mean brightness the bottom band reads as empty/letterboxed.
// Measured separation on real sermons: filled bottoms score >40, empty ones <30.
const MIN_BOTTOM_BRIGHTNESS = 35;

// Mean per-pixel difference between the top and bottom halves. When the model
// tiles/stacks the layout twice, the halves are near-identical and this is very
// low; a normal poster (headline on top, person below) scores much higher.
async function topBottomDiff(data: Buffer): Promise<number> {
  const meta = await sharp(data).metadata();
  const h = meta.height ?? 0;
  const w = meta.width ?? 0;
  if (!h || !w) return 255;
  const half = Math.floor(h / 2);
  const opts = { width: 48, height: 48, fit: "fill" as const };
  const top = await sharp(data).extract({ left: 0, top: 0, width: w, height: half }).resize(opts).greyscale().raw().toBuffer();
  const bot = await sharp(data).extract({ left: 0, top: h - half, width: w, height: half }).resize(opts).greyscale().raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < top.length; i++) diff += Math.abs(top[i] - bot[i]);
  return diff / top.length;
}

// Below this top/bottom difference the image is almost certainly tiled.
const MIN_TOP_BOTTOM_DIFF = 15;

/**
 * Reposition to 2:3 and guard against the two common Nano Banana failures:
 * letterboxing (empty/black bottom) and tiling (the layout stacked twice).
 * Regenerates up to `attempts` times and returns the best result — one that is
 * both not tiled and has a filled bottom, else the closest available.
 */
export async function repositionTo2x3Filled(
  input: ImageData,
  attempts = 3
): Promise<ImageData & { attempts: number; bottomBrightness: number; topBottomDiff: number }> {
  let best: (ImageData & { brightness: number; diff: number }) | null = null;
  let used = 0;
  for (let i = 0; i < attempts; i++) {
    used = i + 1;
    const out = await repositionTo2x3(input);
    let brightness = 255;
    let diff = 255;
    try {
      brightness = await bottomBandBrightness(out.data);
      diff = await topBottomDiff(out.data);
    } catch {
      // measurement failed — treat as acceptable
    }
    const tiled = diff < MIN_TOP_BOTTOM_DIFF;
    const filled = brightness >= MIN_BOTTOM_BRIGHTNESS;
    // Score: never prefer a tiled result; among the rest, prefer brighter.
    const score = (tiled ? -1000 : 0) + brightness;
    const bestScore = best ? (best.diff < MIN_TOP_BOTTOM_DIFF ? -1000 : 0) + best.brightness : -Infinity;
    if (score > bestScore) best = { ...out, brightness, diff };
    if (!tiled && filled) break; // clean fill — stop early
  }
  const b = best as ImageData & { brightness: number; diff: number };
  return {
    data: b.data,
    mimeType: b.mimeType,
    attempts: used,
    bottomBrightness: Math.round(b.brightness),
    topBottomDiff: Math.round(b.diff),
  };
}
