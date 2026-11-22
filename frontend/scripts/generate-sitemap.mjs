// Runs before every build (npm "prebuild"). Writes public/sitemap.xml with the
// homepage plus one URL per hostel pulled from the live API, so new listings
// become discoverable on the next deploy. If the API is unreachable the build
// still succeeds with a homepage-only sitemap.
import { writeFileSync, readFileSync, existsSync } from "fs";

const SITE = (process.env.VITE_SITE_URL || "https://staynex.vercel.app").replace(/\/$/, "");

function apiBase() {
  if (process.env.VITE_API_URL) return process.env.VITE_API_URL;
  if (existsSync(".env")) {
    const m = readFileSync(".env", "utf8").match(/^VITE_API_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

let hostels = [];
const base = apiBase();
if (base && !base.includes("localhost")) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/hostels`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) hostels = await res.json();
  } catch (err) {
    console.warn(`sitemap: couldn't fetch hostels (${err.message}) — writing homepage only`);
  }
} else {
  console.warn("sitemap: VITE_API_URL not set to a deployed API — writing homepage only");
}

const today = new Date().toISOString().slice(0, 10);
const urls = [
  `  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
  ...hostels.map((h) => `  <url><loc>${SITE}/hostels/${encodeURIComponent(h.id)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
];
writeFileSync("public/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
console.log(`sitemap: wrote ${urls.length} URL(s)`);
