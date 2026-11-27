/** /site.webmanifest: the site's name and icons (pipeline/src/site.ts). */
import { siteConfig } from "../../../pipeline/src/site.ts";

export function GET() {
  const site = siteConfig(), p = site.icons;
  return new Response(JSON.stringify({
    name: site.name,
    short_name: site.name,
    description: site.home ? site.description : "Isometric city maps from open data, painted with AI.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0f12",
    theme_color: "#0e0f12",
    icons: [
      { src: `${p}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${p}/icon-512.png`, sizes: "512x512", type: "image/png" },
      { src: `${p}/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2) + "\n", { headers: { "Content-Type": "application/manifest+json" } });
}
