#!/usr/bin/env node
// Operational helper for the sermon vertical-thumbnail pipeline.
//
//   node scripts/sermon-thumbnails.mjs register <webhook-url>   # register Webflow webhooks
//   node scripts/sermon-thumbnails.mjs list                     # list existing webhooks
//   node scripts/sermon-thumbnails.mjs unregister               # remove webhooks pointing at our route
//   node scripts/sermon-thumbnails.mjs backfill <webhook-url> [--limit N]
//                                                               # fire the endpoint for sermons missing a vertical thumb
//
// <webhook-url> is your deployed route, e.g.
//   https://YOUR-APP.vercel.app/api/webflow/sermon-thumbnail?secret=YOUR_SECRET
//
// Requires WEBFLOW_API_TOKEN (and the same WEBHOOK_SECRET, baked into the URL).

const API = "https://api.webflow.com/v2";
const SITE_ID = process.env.WEBFLOW_SITE_ID || "6966af986dd3f5b0369a84ce";
const COLLECTION_ID = process.env.WEBFLOW_SERMONS_COLLECTION_ID || "6975c0cf81c37225e0e2aadd";
const TRIGGERS = ["collection_item_created", "collection_item_changed"];
const ROUTE_MARKER = "/api/webflow/sermon-thumbnail";

function token() {
  const t = process.env.WEBFLOW_API_TOKEN;
  if (!t) throw new Error("Set WEBFLOW_API_TOKEN.");
  return t;
}

async function wf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function register(url) {
  if (!url) throw new Error("Usage: register <webhook-url>");
  for (const triggerType of TRIGGERS) {
    const created = await wf(`/sites/${SITE_ID}/webhooks`, {
      method: "POST",
      body: JSON.stringify({ triggerType, url }),
    });
    console.log(`registered ${triggerType} -> ${created.id}`);
  }
}

async function list() {
  const { webhooks = [] } = await wf(`/sites/${SITE_ID}/webhooks`);
  for (const w of webhooks) console.log(`${w.id}  ${w.triggerType}  ${w.url}`);
  if (!webhooks.length) console.log("(none)");
}

async function unregister() {
  const { webhooks = [] } = await wf(`/sites/${SITE_ID}/webhooks`);
  const ours = webhooks.filter((w) => (w.url || "").includes(ROUTE_MARKER));
  for (const w of ours) {
    await wf(`/sites/${SITE_ID}/webhooks/${w.id}`, { method: "DELETE" });
    console.log(`deleted ${w.id} (${w.triggerType})`);
  }
  if (!ours.length) console.log("no matching webhooks found");
}

async function backfill(url, limit) {
  if (!url) throw new Error("Usage: backfill <webhook-url> [--limit N]");
  let offset = 0;
  let processed = 0;
  for (;;) {
    const { items = [] } = await wf(`/collections/${COLLECTION_ID}/items?limit=100&offset=${offset}`);
    if (!items.length) break;
    for (const item of items) {
      if (limit && processed >= limit) return;
      const fd = item.fieldData || {};
      const hasVertical = fd["vertical-thumbnail"]?.url || fd["vertical-thumbnail"]?.fileId;
      const hasHorizontal = fd["thumbnail"]?.url;
      if (hasVertical || !hasHorizontal) continue;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerType: "backfill", payload: { id: item.id, collectionId: COLLECTION_ID } }),
      });
      console.log(`${item.fieldData?.name || item.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      processed++;
    }
    offset += items.length;
  }
  console.log(`done — ${processed} item(s) triggered`);
}

const [cmd, arg] = process.argv.slice(2);
const limitFlag = process.argv.indexOf("--limit");
const limit = limitFlag > -1 ? Number(process.argv[limitFlag + 1]) : 0;

const run = {
  register: () => register(arg),
  list,
  unregister,
  backfill: () => backfill(arg, limit),
}[cmd];

if (!run) {
  console.error("commands: register <url> | list | unregister | backfill <url> [--limit N]");
  process.exit(1);
}
run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
