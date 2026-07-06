// Nano Banana (Gemini 2.5 Flash Image) via the Google AI Studio / Generative
// Language API. Given a sermon's 16:9 horizontal thumbnail, it repositions the
// existing content into a 2:3 vertical frame — without altering the person or
// imagery — so it can be used as the sermon's vertical thumbnail.
//
// Requires a Google AI Studio API key. We accept the common env-var names so it
// works regardless of which one was set in Vercel.
const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

// The exact prompt Landmark verified as "working" for this reposition task.
export const REPOSITION_PROMPT =
  "Keep all the content the same. Do not change content or imagery. Do not " +
  "visually change the person in the image at all. Your job is to simply " +
  "reposition the content so that it is in a 2:3 view. The only " +
  "content/imagery/info that you are able to remove is the verse reference and " +
  "subtitle. Here is the order of priority as far as content goes: Pastor " +
  "picture, Title, sub title, verse ref. Refrain from putting any text on the " +
  "bottom half of the image.";

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
