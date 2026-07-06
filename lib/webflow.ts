// Webflow Data API v2 helpers for the sermon vertical-thumbnail pipeline:
// read a sermon item, upload a generated image to the site's asset library,
// write it to the item's "vertical-thumbnail" field, and publish the item.
//
// Requires WEBFLOW_API_TOKEN (Site settings -> Apps & integrations -> API
// access, or a workspace token) with CMS + Assets read/write scopes.
import crypto from "crypto";

const API = "https://api.webflow.com/v2";

// Defaults resolved from the live Landmark Church site; override via env if the
// site or collection ever moves.
export const SITE_ID = process.env.WEBFLOW_SITE_ID || "6966af986dd3f5b0369a84ce";
export const SERMONS_COLLECTION_ID =
  process.env.WEBFLOW_SERMONS_COLLECTION_ID || "6975c0cf81c37225e0e2aadd";

const THUMBNAIL_FIELD = "thumbnail";
const VERTICAL_THUMBNAIL_FIELD = "vertical-thumbnail";

function token(): string {
  const t = process.env.WEBFLOW_API_TOKEN;
  if (!t) throw new Error("Missing WEBFLOW_API_TOKEN.");
  return t;
}

async function wf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Webflow ${init.method || "GET"} ${path} -> ${res.status}: ${detail.slice(0, 500)}`);
  }
  // Some endpoints (publish) may return an empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

interface ImageFieldValue {
  fileId?: string;
  url?: string;
  alt?: string | null;
}

export interface SermonItem {
  id: string;
  isDraft?: boolean;
  lastPublished?: string | null;
  fieldData: {
    name?: string;
    slug?: string;
    [THUMBNAIL_FIELD]?: ImageFieldValue | null;
    [VERTICAL_THUMBNAIL_FIELD]?: ImageFieldValue | null;
    [key: string]: unknown;
  };
}

export async function getSermon(itemId: string): Promise<SermonItem> {
  return wf<SermonItem>(`/collections/${SERMONS_COLLECTION_ID}/items/${itemId}`);
}

export function horizontalThumbnailUrl(item: SermonItem): string | null {
  return item.fieldData?.[THUMBNAIL_FIELD]?.url ?? null;
}

export function hasVerticalThumbnail(item: SermonItem): boolean {
  return Boolean(item.fieldData?.[VERTICAL_THUMBNAIL_FIELD]?.url || item.fieldData?.[VERTICAL_THUMBNAIL_FIELD]?.fileId);
}

export interface UploadedAsset {
  id: string;
  hostedUrl: string;
}

interface CreateAssetResponse {
  id: string;
  hostedUrl: string;
  uploadUrl: string;
  uploadDetails: Record<string, string>;
}

/**
 * Upload image bytes to the site's asset library using Webflow's two-step
 * (metadata -> S3 form POST) flow, and return the asset id + hosted URL.
 */
export async function uploadAsset(fileName: string, data: Buffer, mimeType: string): Promise<UploadedAsset> {
  const fileHash = crypto.createHash("md5").update(data).digest("hex");

  const meta = await wf<CreateAssetResponse>(`/sites/${SITE_ID}/assets`, {
    method: "POST",
    body: JSON.stringify({ fileName, fileHash }),
  });

  const form = new FormData();
  // The S3 form fields must be appended before the file part.
  for (const [k, v] of Object.entries(meta.uploadDetails)) form.append(k, v);
  const contentType = meta.uploadDetails["content-type"] || meta.uploadDetails["Content-Type"] || mimeType;
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType }), fileName);

  const upload = await fetch(meta.uploadUrl, { method: "POST", body: form });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => "");
    throw new Error(`Asset upload to storage failed ${upload.status}: ${detail.slice(0, 300)}`);
  }

  return { id: meta.id, hostedUrl: meta.hostedUrl };
}

export async function setVerticalThumbnail(itemId: string, asset: UploadedAsset, alt: string | null): Promise<void> {
  await wf(`/collections/${SERMONS_COLLECTION_ID}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({
      fieldData: {
        [VERTICAL_THUMBNAIL_FIELD]: { fileId: asset.id, url: asset.hostedUrl, alt },
      },
    }),
  });
}

export async function publishItems(itemIds: string[]): Promise<void> {
  await wf(`/collections/${SERMONS_COLLECTION_ID}/items/publish`, {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}
