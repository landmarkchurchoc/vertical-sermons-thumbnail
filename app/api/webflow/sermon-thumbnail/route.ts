import { NextRequest, NextResponse } from "next/server";
import { repositionTo2x3Filled, optimizeForWeb } from "@/lib/gemini";
import {
  SERMONS_COLLECTION_ID,
  getSermon,
  horizontalThumbnailUrl,
  hasVerticalThumbnail,
  ensureAssetFolder,
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

  let body: {
    triggerType?: string;
    payload?: { id?: string; collectionId?: string; fieldData?: Record<string, unknown> };
  };
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

  // ?force=1 regenerates even if a vertical thumbnail already exists (used to
  // overwrite earlier low-quality renders; not set by Webflow's own webhooks).
  const force = ["1", "true", "yes"].includes((req.nextUrl.searchParams.get("force") || "").toLowerCase());

  // Fast path: the webhook payload already carries the item's fields. If it
  // shows a vertical thumbnail is set, skip without any Webflow API call. This
  // is what keeps bulk CMS edits (e.g. updating speaker names on sermons that
  // already have thumbnails) from hammering the API — the common case costs
  // zero requests — and it absorbs the "changed" event our own write fires.
  const vt = body.payload?.fieldData?.["vertical-thumbnail"] as
    | { url?: string; fileId?: string }
    | null
    | undefined;
  if (!force && (vt?.url || vt?.fileId)) {
    return NextResponse.json({ skipped: "vertical-thumbnail already set (from payload)", itemId });
  }

  try {
    const result = await processSermon(itemId, force);
    return NextResponse.json(result);
  } catch (err) {
    console.error("sermon-thumbnail error:", err);
    // Acknowledge with 200 even on failure. Returning 5xx makes Webflow retry
    // the delivery, which during a rate-limit burst (e.g. bulk CMS edits) piles
    // on more API calls and amplifies the storm. The Webflow helper already
    // retries transient 429/5xx internally; anything that still fails here is
    // left for the next "changed" event or a manual backfill to pick up.
    return NextResponse.json(
      { ok: false, deferred: true, error: String(err instanceof Error ? err.message : err) },
      { status: 200 }
    );
  }
}

async function processSermon(itemId: string, force = false) {
  const item = await getSermon(itemId);

  // Already done — don't regenerate or re-publish (avoids self-trigger loops).
  // `force` overrides this to overwrite an existing thumbnail on demand.
  if (!force && hasVerticalThumbnail(item)) {
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

  // 2. Reposition to 2:3 with Nano Banana (retries if the bottom comes out empty).
  const generated = await repositionTo2x3Filled({ data: srcBuf, mimeType: srcMime });

  // 3. Compress + convert to a lightweight web format (default WebP, ~500 KB).
  const optimized = await optimizeForWeb(generated);

  // 4. Upload the generated image to the Webflow asset library, corralled into a
  //    dedicated folder so it doesn't clutter the top level of the Asset Manager.
  //    (CMS image fields must reference a hosted asset, so the file has to live
  //    in the library — the folder just keeps these auto-renders organized.)
  const folderId = await ensureAssetFolder();
  // Webflow rejects long asset file names, so cap the slug-based base.
  const base = (item.fieldData.slug || itemId).slice(0, 60);
  const asset = await uploadAsset(`${base}-vertical.${optimized.ext}`, optimized.data, optimized.mimeType, folderId);

  // 5. Write the field and publish.
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

  return {
    ok: true,
    itemId,
    assetId: asset.id,
    assetUrl: asset.hostedUrl,
    published,
    format: optimized.mimeType,
    fileKB: Math.round(optimized.bytes / 1024),
    folderId: folderId ?? null,
    attempts: generated.attempts,
    bottomBrightness: generated.bottomBrightness,
    topBottomDiff: generated.topBottomDiff,
  };
}

// Simple health check for wiring up the webhook URL.
export async function GET() {
  return NextResponse.json({ ok: true, service: "sermon vertical-thumbnail webhook" });
}
