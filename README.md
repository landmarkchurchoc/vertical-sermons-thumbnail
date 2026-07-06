# Sermon Vertical Thumbnails

Automatically generates a **2:3 vertical thumbnail** for every sermon added to the
Landmark Church Webflow **Sermons** collection, using **Nano Banana**
(Gemini 2.5 Flash Image, via Google AI Studio).

```
Webflow "sermon created/changed" webhook
        │
        ▼
/api/webflow/sermon-thumbnail
        │  1. read the Sermon item (skip if it already has a vertical thumbnail)
        │  2. download the 16:9 `thumbnail`
        │  3. Nano Banana reflows it to 2:3 (aspectRatio 2:3 + the reposition prompt)
        │  4. upload the result to the Webflow asset library
        │  5. write it to `vertical-thumbnail` and publish the item
        ▼
Sermon item now has a published 2:3 vertical thumbnail
```

The route is **idempotent** — it skips items that already have a vertical thumbnail,
so Webflow retries and the "changed" event triggered by its own write are no-ops.

## Deploy (Vercel)

This repo is connected to the Vercel project `vertical-sermons-thumbnail`; pushes to
`main` deploy automatically.

### Environment variables (Vercel → Settings → Environment Variables)

- `GEMINI_API_KEY` — Google AI Studio key
- `WEBFLOW_API_TOKEN` — Webflow Data API token with CMS + Assets read/write
- `WEBHOOK_SECRET` — random string; guards the webhook route

### Register the Webflow webhooks

Point them at the deployed route with the secret baked in:

```bash
WEBFLOW_API_TOKEN=... node scripts/sermon-thumbnails.mjs \
  register "https://vertical-sermons-thumbnail.vercel.app/api/webflow/sermon-thumbnail?secret=YOUR_SECRET"
```

Registers `collection_item_created` and `collection_item_changed` (both site-wide;
the route filters to the Sermons collection). Use `list` / `unregister` to inspect
or remove them.

### Backfill existing sermons

```bash
WEBFLOW_API_TOKEN=... node scripts/sermon-thumbnails.mjs \
  backfill "https://vertical-sermons-thumbnail.vercel.app/api/webflow/sermon-thumbnail?secret=YOUR_SECRET" --limit 1
```

Drop `--limit 1` to run them all; `--limit 1` is a good first smoke test.

## Local development

```bash
npm install
cp .env.example .env   # fill in keys
npm run dev            # http://localhost:3000
```

## The reposition prompt

The exact prompt sent to Nano Banana lives in [`lib/gemini.ts`](lib/gemini.ts)
(`REPOSITION_PROMPT`) and the output frame is forced to 2:3 via
`generationConfig.imageConfig.aspectRatio`.
