// api/whatnot.js

export const config = {
  runtime: "nodejs",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

const BUDGET_MS = 15000; // Zeitbudget pro Request

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (typeof obj[k] === "string" && obj[k]) return obj[k];
  }
  return null;
}

function walk(obj, cb) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    try {
      cb(k, obj[k]);
    } catch {}
    walk(obj[k], cb);
  }
}

function extractNextData(html) {
  // Robust gegen Zeilenumbrüche / zusätzliche Attribute
  const re =
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractFromNextData(nextData) {
  const shows = [];
  if (!nextData) return shows;
  const seen = new Set();

  walk(nextData, (_k, v) => {
    if (Array.isArray(v)) {
      for (const it of v) {
        const raw = pick(it, ["url", "href", "permalink", "path", "slug"]);
        const title = pick(it, ["title", "name"]);
        const image = pick(it, [
          "image",
          "img",
          "coverImage",
          "cover_image_url",
          "thumbnail",
          "cover",
        ]);
        const start_at = pick(it, [
          "startAt",
          "start_at",
          "startsAt",
          "scheduled_start_time",
        ]);

        let fullUrl = null;
        if (typeof raw === "string") {
          fullUrl = raw.startsWith("http")
            ? raw
            : `https://www.whatnot.com${
                raw.startsWith("/") ? "" : "/"
              }${raw}`;
        }

        if (
          fullUrl &&
          /https?:\/\/www\.whatnot\.com\/live\//i.test(fullUrl) &&
          !seen.has(fullUrl)
        ) {
          seen.add(fullUrl);
          shows.push({
            title: title || "Whatnot Show",
            url: fullUrl,
            image: image || null,
            start_at: start_at || null,
          });
        }
      }
    }
  });

  shows.sort(
    (a, b) =>
      (a.start_at ? Date.parse(a.start_at) : Infinity) -
      (b.start_at ? Date.parse(b.start_at) : Infinity)
  );
  return shows.slice(0, 12);
}

function extractFromHTML(html) {
  const shows = [];
  const seen = new Set();

  // Links auf /live/ einsammeln
  const linkRe = /<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    if (!href) continue;
    const abs = href.startsWith("http")
      ? href
      : `https://www.whatnot.com${href.startsWith("/") ? "" : "/"}${href}`;
    if (!/https?:\/\/www\.whatnot\.com\/live\//i.test(abs)) continue;

    if (seen.has(abs)) continue;
    seen.add(abs);

    // Versuche, einen Titel aus aria-label/alt/text zu fischen
    const aTag = m[0];
    const aria =
      /aria-label=["']([^"']+)["']/i.exec(aTag)?.[1]?.trim() || null;
    const alt = /alt=["']([^"']+)["']/i.exec(aTag)?.[1]?.trim() || null;
    const text = aTag.replace(/<[^>]*>/g, "").trim() || null;

    shows.push({
      title: aria || alt || text || "Whatnot Show",
      url: abs,
      image: null,
      start_at: null,
    });
  }

  return shows.slice(0, 12);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const username = String(req.query.user || "skycard").trim();
  const url = `https://www.whatnot.com/user/${encodeURIComponent(
    username
  )}/shows`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const status = r.status;
    const html = await r.text();

    // Falls Anti-Bot Seite (503 / "Just a moment"), trotzdem versuchen
    let shows = [];
    const nextData = extractNextData(html);
    if (nextData) {
      shows = extractFromNextData(nextData);
    }
    if (!shows.length) {
      shows = extractFromHTML(html);
    }

    // Debug für Logs (Vercel)
    console.log("whatnot fetch status:", status, "shows:", shows.length);

    return res.status(200).json({ user: username, shows });
  } catch (err) {
    console.error("whatnot fetch error:", err);
    return res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}
