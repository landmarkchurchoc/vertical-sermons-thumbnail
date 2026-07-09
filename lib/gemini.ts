// Nano Banana (Gemini 2.5 Flash Image) via the Google AI Studio / Generative
// Language API. Given a sermon's 16:9 horizontal thumbnail, it repositions the
// existing content into a 2:3 vertical frame — without altering the person or
// imagery — so it can be used as the sermon's vertical thumbnail.
//
// Requires a Google AI Studio API key. We accept the common env-var names so it
// works regardless of which one was set in Vercel.
import sharp from "sharp";
import { REFERENCE_2X3_B64, REFERENCE_2X3_MIME } from "./reference-image";

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

// Prompt for reflowing a 16:9 sermon graphic into a 2:3 vertical thumbnail.
// Two images are sent: a fixed STYLE REFERENCE (the "Broken for Battle" gold
// standard) and the SOURCE to reformat. The heavy anti-duplication language is
// deliberate — without it the model tiles/stacks the layout twice to fill 2:3.
export const REPOSITION_PROMPT =
  "You are reformatting a 16:9 church sermon graphic into a SINGLE, cohesive " +
  "2:3 vertical (portrait) thumbnail.\n\n" +
  "The FIRST image is a STYLE REFERENCE showing the target vertical layout: " +
  "one subject, a large headline in the upper area, a small speaker/label, and " +
  "a full-bleed background that fills the entire frame. Match this composition " +
  "and balance — but DO NOT copy its content, person, colors, or words.\n\n" +
  "The SECOND image is the SOURCE. Use ONLY its content: its person, its title " +
  "text, its colors, and its background imagery.\n\n" +
  "Absolute rules:\n" +
  "1. Produce ONE unified poster. NEVER tile, stack, mirror, split, repeat, or " +
  "duplicate any element. The person must appear EXACTLY ONCE. Each word of the " +
  "title must appear EXACTLY ONCE.\n" +
  "2. Do not visually change the person — keep their face, body, and clothing " +
  "identical to the source.\n" +
  "3. Keep the title text complete and legible exactly as written in the " +
  "source. Never crop, cut off, abbreviate, or garble words.\n" +
  "4. Fill the ENTIRE 2:3 frame edge to edge by naturally extending the " +
  "source's own background. No empty, black, or letterboxed bars anywhere.\n" +
  "5. Place the title in the upper portion and the person in the lower/center; " +
  "keep text off the very bottom.\n" +
  "6. You may remove the verse reference and the subtitle. Priority for what " +
  "to keep: person, title, subtitle, verse reference.\n\n" +
  "The final image should read like one professionally designed vertical movie " +
  "poster: one subject, one headline, full-bleed background, nothing repeated.";

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
          { text: "FIRST image — STYLE REFERENCE (layout only, do not copy its content):" },
          { inline_data: { mime_type: REFERENCE_2X3_MIME, data: REFERENCE_2X3_B64 } },
          { text: "SECOND image — SOURCE (reformat THIS content into the 2:3 layout):" },
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
