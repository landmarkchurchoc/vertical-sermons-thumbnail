export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "10vh auto", padding: "0 1.5rem", lineHeight: 1.5 }}>
      <h1>Sermon Vertical Thumbnails</h1>
      <p>
        This service listens for Webflow Sermons collection webhooks and turns each sermon&apos;s
        16:9 thumbnail into a 2:3 vertical thumbnail using Nano Banana (Gemini 2.5 Flash Image),
        then writes it back to the sermon and publishes it.
      </p>
      <p>
        Webhook endpoint: <code>/api/webflow/sermon-thumbnail</code>
      </p>
    </main>
  );
}
