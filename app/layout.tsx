export const metadata = {
  title: "Sermon Vertical Thumbnails",
  description: "Nano Banana → Webflow vertical sermon thumbnail generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}
