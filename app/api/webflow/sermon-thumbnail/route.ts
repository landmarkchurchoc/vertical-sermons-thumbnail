import { NextRequest, NextResponse } from "next/server";
import { repositionTo2x3 } from "@/lib/gemini";
import {
  SERMONS_COLLECTION_ID,
  getSermon,
  horizontalThumbnailUrl,
  hasVerticalThumbnail,
  uploadAsset,
  setVerticalThumbnail,
  publishItems,
} from "@/lib/webflow";

export const runtime = "nodejs";
export const maxDuration = 60;

// Webhook receiver for Webflow "collection_item_created" / "collection_item_changed"
// events. When a Sermons item has a 16:9 thumbnail but no vertical thumbnail, it
// asks Nano Banana to reflow the thumbnail to 2:3, uploads the result, writes it
// to the item's "vertical-thumbnail" field, and publishes the item.
//
// Idempotent: if the vertical thumbnail already exists we skip, so Webflow
// retries and the self-triggered "changed" event from our own write are no-ops.

export async function POST(req: NextRequest) {
  // Shared-secret guard (Data-API webhooks aren't signed). Configure the webhook
  // URL as .../sermon-thumbnail?secret=YOUR_SECRET and set WEBHOOK_SECRET in Vercel.
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.nextUrl.searchParams.get("secret") || req.headers.get("x-webhook-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: { triggerType?: string; payload?: { id?: string; collectionId?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const collectionId = body.payload?.collectionId;
  const itemId = body.payload?.id;

  // Webflow collection webhooks are site-wide — ignore anything that isn't a Sermon.
  if (collectionId !== SERMONS_COLLECTION_ID || !itemId) {
    return NextResponse.json({ skipped: "not a sermons item" });
  }

  try {
    const result = await processSermon(itemId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("sermon-thumbnail error:", err);
    // 500 lets Webflow retry transient failures; the guard keeps retries safe.
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}

async function processSermon(itemId: string) {
  const item = await getSermon(itemId);

  // Already done — don't regenerate or re-publish (avoids self-trigger loops).
  if (hasVerticalThumbnail(item)) {
    return { skipped: "vertical-thumbnail already set", itemId };
  }

  const sourceUrl = horizontalThumbnailUrl(item);
  if (!sourceUrl) {
    return { skipped: "no horizontal thumbnail yet", itemId };
  }

  // 1. Download the 16:9 thumbnail.
  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) throw new Error(`thumbnail download failed ${srcRes.status}`);
  const srcBuf = Buffer.from(await srcRes.arrayBuffer());
  const srcMime = srcRes.headers.get("content-type")?.split(";")[0] || "image/jpeg";

  // 2. Reposition to 2:3 with Nano Banana.
  const generated = await repositionTo2x3({ data: srcBuf, mimeType: srcMime });

  // 3. Upload the generated image to the Webflow asset library.
  const ext = generated.mimeType.includes("png")
    ? "png"
    : generated.mimeType.includes("webp")
      ? "webp"
      : "jpg";
  const slug = item.fieldData.slug || itemId;
  const asset = await uploadAsset(`${slug}-vertical.${ext}`, generated.data, generated.mimeType);

  // 4. Write the field and publish.
  const alt = item.fieldData.name ? `${item.fieldData.name} — vertical thumbnail` : null;
  await setVerticalThumbnail(itemId, asset, alt);

  let published = true;
  try {
    await publishItems([itemId]);
  } catch (err) {
    // Field is saved to staging even if publish fails (e.g. item still a draft);
    // it will go live on the next publish. Surface it without failing the run.
    published = false;
    console.warn("sermon-thumbnail: field saved but publish failed:", err);
  }

  return { ok: true, itemId, assetId: asset.id, assetUrl: asset.hostedUrl, published };
}

// Simple health check for wiring up the webhook URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "sermon vertical-thumbnail webhook" });
}
