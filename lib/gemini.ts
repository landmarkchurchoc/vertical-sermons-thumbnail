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
// The emphasis on filling the entire frame is deliberate: a looser prompt makes
// the model letterbox the 16:9 content into the top and leave the bottom black.
export const REPOSITION_PROMPT =
  "Transform this 16:9 sermon graphic into a 2:3 vertical (portrait) image. " +
  "Do not change content or imagery, and do not visually change the person in " +
  "the image at all — keep their face, body, and clothing exactly the same. " +
  "CRITICAL: fill the ENTIRE 2:3 frame edge to edge. Naturally extend the " +
  "pastor and the background scene downward so there is NO empty, black, blank, " +
  "or letterboxed area anywhere, especially across the bottom. You may enlarge " +
  "the pastor and let the figure extend into the lower portion of the frame so " +
  "the composition looks intentional and full. Keep the title and any text in " +
  "the upper portion of the image; refrain from putting text on the bottom " +
  "half. The only content you may remove is the verse reference and the " +
  "subtitle. Order of priority for what to keep: pastor picture, title, " +
  "subtitle, verse reference.";

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

/**
 * Reposition to 2:3 and guard against letterboxing: if the generated image has
 * a near-empty (black) bottom band, regenerate — the model is stochastic and
 * usually fills the frame on another attempt. Returns the best of up to
 * `attempts` tries (the one with the brightest bottom band).
 */
export async function repositionTo2x3Filled(
  input: ImageData,
  attempts = 3
): Promise<ImageData & { attempts: number; bottomBrightness: number }> {
  let best: ImageData | null = null;
  let bestBrightness = -1;
  let used = 0;
  for (let i = 0; i < attempts; i++) {
    used = i + 1;
    const out = await repositionTo2x3(input);
    let brightness: number;
    try {
      brightness = await bottomBandBrightness(out.data);
    } catch {
      brightness = 255; // measurement failed — accept this result
    }
    if (brightness > bestBrightness) {
      best = out;
      bestBrightness = brightness;
    }
    if (brightness >= MIN_BOTTOM_BRIGHTNESS) break; // good fill — stop early
  }
  return { ...(best as ImageData), attempts: used, bottomBrightness: Math.round(bestBrightness) };
}
