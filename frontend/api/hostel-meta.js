// Vercel serverless function. Search engines and link-preview bots (WhatsApp,
// Facebook, X, Telegram...) don't reliably run the React app, so for THEIR
// requests to /hostels/:id vercel.json rewrites here: real <title>, meta,
// Open Graph tags, JSON-LD and readable content for that specific hostel.
// Humans never hit this — they get the normal SPA.
//
// Env (Vercel project settings): API_URL (e.g. https://your-api.onrender.com/api),
// optional SITE_URL.

const SITE = (process.env.SITE_URL || "https://staynex.vercel.app").replace(/\/$/, "");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const jsonLd = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
const UUID = /^[0-9a-f-]{36}$/i;

export function renderHostelPage(hostel, id) {
  const rooms = hostel.rooms || [];
  const prices = rooms.map((r) => Number(r.price_per_year)).filter(Number.isFinite);
  const from = prices.length ? Math.min(...prices) : null;
  const openBeds = rooms.reduce((n, r) => n + (r.beds || []).filter((b) => b.status === "available").length, 0);
  const image = hostel.media?.find((m) => m.resource_type === "image")?.url;
  const url = `${SITE}/hostels/${id}`;
  const title = `${hostel.name} — Student Hostel in ${hostel.area} | StayNex`;
  const desc = `Book a bed at ${hostel.name} in ${hostel.area}.` +
    (from ? ` Rooms from ₵${from.toLocaleString("en-US")} per year.` : "") +
    (openBeds ? ` ${openBeds} bed${openBeds === 1 ? "" : "s"} available now.` : "") +
    " Reserve online with a flexible deposit.";

  const ld = {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    name: hostel.name,
    description: desc,
    url,
    address: { "@type": "PostalAddress", addressLocality: hostel.area, addressCountry: "GH" },
    ...(image ? { image } : {}),
    ...(hostel.latitude && hostel.longitude
      ? { geo: { "@type": "GeoCoordinates", latitude: Number(hostel.latitude), longitude: Number(hostel.longitude) } }
      : {}),
    ...(from ? { priceRange: `From GHS ${from}` } : {}),
    ...((hostel.includes || []).length ? { amenityFeature: hostel.includes.map((a) => ({ "@type": "LocationFeatureSpecification", name: a, value: true })) } : {}),
  };

  const roomList = rooms.map((r) => `<li>${esc(r.room_type)} — room ${esc(r.room_code)} — ₵${Number(r.price_per_year).toLocaleString("en-US")}/year</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(url)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="StayNex" />
<meta property="og:title" content="${esc(title)}" /><meta property="og:description" content="${esc(desc)}" /><meta property="og:url" content="${esc(url)}" />
${image ? `<meta property="og:image" content="${esc(image)}" /><meta name="twitter:card" content="summary_large_image" />` : ""}
<script type="application/ld+json">${jsonLd(ld)}</script>
</head><body>
<h1>${esc(hostel.name)}</h1><p>${esc(hostel.area)}${hostel.gender_policy && hostel.gender_policy !== "mixed" ? ` · ${esc(hostel.gender_policy)} students only` : ""}</p>
<p>${esc(desc)}</p>
${(hostel.includes || []).length ? `<p>Includes: ${hostel.includes.map(esc).join(", ")}</p>` : ""}
${roomList ? `<h2>Rooms</h2><ul>${roomList}</ul>` : ""}
${hostel.additional_info ? `<p>${esc(hostel.additional_info)}</p>` : ""}
<p><a href="${esc(url)}">Book on StayNex</a></p>
</body></html>`;
}

export default async function handler(req, res) {
  const id = String(req.query?.id || "");
  const api = (process.env.API_URL || process.env.VITE_API_URL || "").replace(/\/$/, "");
  if (!UUID.test(id) || !api) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  try {
    const r = await fetch(`${api}/hostels/${id}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) { res.statusCode = 404; return res.end("Hostel not found"); }
    if (!r.ok) throw new Error(`API ${r.status}`);
    const html = renderHostelPage(await r.json(), id);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
    res.statusCode = 200;
    res.end(html);
  } catch (err) {
    console.error("hostel-meta failed:", err.message);
    res.statusCode = 503; // tells crawlers to retry later instead of indexing an empty page
    res.setHeader("Retry-After", "300");
    res.end("Temporarily unavailable");
  }
}
