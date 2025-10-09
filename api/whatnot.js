// api/whatnot.js
// Erweiterter Endpoint: holt erst die Shows-Liste (ohne Browser) und reichert
// jede Show mit Titel, Startzeit und Bild über die Detailseite an.

export const config = {
  runtime: "nodejs",
};

// ---------- Einstellungen ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

// Zeitbudget für den gesamten Request
const TOTAL_BUDGET_MS = 15000;

// Pro Detailseite
const DETAIL_TIMEOUT_MS = 3500;

// Anzahl Shows und Parallelität
const MAX_SHOWS = 8;
const CONCURRENCY = 4;

// ---------- Hilfen ----------
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

function extractScriptJSON(html, idOrRe) {
  const re =
    idOrRe instanceof RegExp
      ? idOrRe
      : new RegExp(`<script[^>]*id=["']${idOrRe}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractNextData(html) {
  return extractScriptJSON(html, "__NEXT_DATA__");
}

function extractJSONLD(html) {
  // holt alle <script type="application/ld+json"> Blocks
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const results = [];
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      results.push(j);
    } catch {}
  }
  return results;
}

function getMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return re.exec(html)?.[1] || null;
}

function toAbs(url) {
  if (!url) return null;
  return url.startsWith("http")
    ? url
    : `https://www.whatnot.com${url.startsWith("/") ? "" : "/"}${url}`;
}

// ---------- Liste aus Profilseite ----------
function extractFromNextDataList(nextData) {
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
          "scheduledStartAt",
        ]);

        const fullUrl = toAbs(raw);

        if (
          fullUrl &&
          /https?:\/\/www\.whatnot\.com\/live\//i.test(fullUrl) &&
          !seen.has(fullUrl)
        ) {
          seen.add(fullUrl);
          shows.push({
            title: title || null,
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
  return shows;
}

function extractFromHTMLList(html) {
  const shows = [];
  const seen = new Set();

  const linkRe = /<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const abs = toAbs(href);
    if (!abs || !/https?:\/\/www\.whatnot\.com\/live\//i.test(abs)) continue;

    if (seen.has(abs)) continue;
    seen.add(abs);

    const aTag = m[0];
    const aria = /aria-label=["']([^"']+)["']/i.exec(aTag)?.[1]?.trim() || null;
    const alt = /alt=["']([^"']+)["']/i.exec(aTag)?.[1]?.trim() || null;
    const text = aTag.replace(/<[^>]*>/g, "").trim() || null;

    shows.push({
      title: aria || alt || text || null,
      url: abs,
      image: null,
      start_at: null,
    });
  }

  return shows;
}

// ---------- Details je Show ----------
function detailFromNextData(nextData) {
  // Versuche, im Next-Datenbaum show-ähnliche Objekte zu finden
  let title = null,
    image = null,
    start_at = null;

  walk(nextData, (_k, v) => {
    if (v && typeof v === "object") {
      if (!title) title = pick(v, ["title", "name", "showTitle"]);
      if (!image)
        image = pick(v, [
          "image",
          "img",
          "coverImage",
          "cover_image_url",
          "thumbnail",
          "cover",
          "ogImage",
        ]);
      if (!start_at)
        start_at = pick(v, [
          "startAt",
          "start_at",
          "startsAt",
          "scheduled_start_time",
          "scheduledStartAt",
          "startDate",
        ]);
    }
  });

  return { title, image, start_at };
}

function detailFromJSONLD(ldBlocks) {
  for (const block of ldBlocks) {
    const list = Array.isArray(block) ? block : [block];
    for (const item of list) {
      if (
        item &&
        (item["@type"] === "Event" ||
          (Array.isArray(item["@type"]) && item["@type"].includes("Event")))
      ) {
        const title = item.name || null;
        const start_at = item.startDate || null;
        const image =
          (Array.isArray(item.image) ? item.image[0] : item.image) || null;
        if (title || start_at || image) return { title, image, start_at };
      }
    }
  }
  return { title: null, image: null, start_at: null };
}

function detailFromMeta(html) {
  const title =
    getMeta(html, "og:title") ||
    getMeta(html, "twitter:title") ||
    null;
  const image =
    getMeta(html, "og:image") ||
    getMeta(html, "twitter:image") ||
    null;

  // eventuelles startDate in JSON im HTML
  const ld = extractJSONLD(html);
  const fromLD = detailFromJSONLD(ld);
  return {
    title: title || fromLD.title,
    image: image || fromLD.image,
    start_at: fromLD.start_at,
  };
}

async function fetchWithTimeout(url, ms, signalFromParent) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const combined = new AbortController();

  const onAbort = () => combined.abort();
  signalFromParent?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () =>
    signalFromParent?.removeEventListener("abort", onAbort);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } finally {
    cleanup();
    clearTimeout(id);
  }
}

async function enrichShow(show, parentAbort) {
  // Detailseite holen mit kleinem Timeout
  try {
    const r = await fetchWithTimeout(show.url, DETAIL_TIMEOUT_MS, parentAbort);
    const html = await r.text();

    let det = { title: null, image: null, start_at: null };

    const next = extractNextData(html);
    if (next) {
      det = detailFromNextData(next);
    }

    if (!det.title || !det.image || !det.start_at) {
      const more = detailFromMeta(html);
      det = {
        title: det.title || more.title,
        image: det.image || more.image,
        start_at: det.start_at || more.start_at,
      };
    }

    // Rückfall: wenn alles leer, belassen — aber kein Error werfen
    return {
      ...show,
      title: det.title || show.title || "Vorschau für Livestream",
      image: det.image || show.image || null,
      start_at: det.start_at || show.start_at || null,
    };
  } catch (e) {
    // Bei Fehlern einfach die Rohversion zurückgeben
    return show;
  }
}

// limitierte Parallelität
async function enrichAll(shows, parentAbort) {
  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < shows.length) {
      const my = idx++;
      const enriched = await enrichShow(shows[my], parentAbort);
      out[my] = enriched;
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, shows.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const username = String(req.query.user || "skycard").trim();
  const profileUrl = `https://www.whatnot.com/user/${encodeURIComponent(
    username
  )}/shows`;

  const globalAbort = new AbortController();
  const budget = setTimeout(() => globalAbort.abort(), TOTAL_BUDGET_MS);

  try {
    // 1) Profilseite holen
    const pr = await fetch(profileUrl, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: globalAbort.signal,
    });

    const html = await pr.text();

    // 2) Shows extrahieren
    let shows = [];
    const next = extractNextData(html);
    if (next) shows = extractFromNextDataList(next);
    if (!shows.length) shows = extractFromHTMLList(html);

    // 3) auf MAX begrenzen
    shows = shows.slice(0, MAX_SHOWS);

    // 4) Details anreichern (Titel, Bild, Startzeit)
    let enriched = shows;
    if (shows.length) {
      enriched = await enrichAll(shows, globalAbort.signal);
    }

    // 5) sortiert nach Startzeit (falls vorhanden)
    enriched.sort(
      (a, b) =>
        (a.start_at ? Date.parse(a.start_at) : Infinity) -
        (b.start_at ? Date.parse(b.start_at) : Infinity)
    );

    console.log("whatnot enriched:", enriched.length);
    return res.status(200).json({ user: username, shows: enriched });
  } catch (err) {
    console.error("whatnot error:", err);
    return res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(budget);
  }
}
