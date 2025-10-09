// api/whatnot.js
// Liefert: title, url, image, start_at (ISO) – ohne Puppeteer

export const config = { runtime: "nodejs" };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

const DEFAULT_LIMIT = 8;
const DETAIL_TIMEOUT_MS = 3500;    // pro Detailseite
const TOTAL_BUDGET_MS  = 15000;    // gesamtes Zeitbudget
const CONCURRENCY      = 4;        // parallele Detail-Requests

// ---------- kleine Helfer ----------
const toInt = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const toAbs = (url) =>
  !url ? null : url.startsWith("http") ? url : `https://www.whatnot.com${url.startsWith("/") ? "" : "/"}${url}`;

function walk(obj, cb) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    try { cb(k, obj[k]); } catch {}
    walk(obj[k], cb);
  }
}
const pick = (o, keys) => (o && typeof o === "object" ? keys.find(k => typeof o[k] === "string" && o[k]) && o[keys.find(k => typeof o[k] === "string" && o[k])] : null);

function extractScriptJSON(html, id) {
  const re = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
const extractNextData = (html) => extractScriptJSON(html, "__NEXT_DATA__");

function extractJSONLD(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}
function getMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return re.exec(html)?.[1] || null;
}

// ---------- Shows aus Profilseite ----------
function fromNextDataList(nextData) {
  const shows = [];
  const seen = new Set();
  walk(nextData, (_k, v) => {
    if (Array.isArray(v)) {
      for (const it of v) {
        const raw = pick(it, ["url", "href", "permalink", "path"]);
        const url = toAbs(raw);
        if (!url || !/https?:\/\/www\.whatnot\.com\/live\//i.test(url) || seen.has(url)) continue;
        seen.add(url);

        const title = pick(it, ["title", "name"]) || null;
        const image = pick(it, ["image", "coverImage", "cover_image_url", "thumbnail", "img", "ogImage"]) || null;

        shows.push({ title, url, image, start_at: null });
      }
    }
  });
  return shows;
}

function fromHTMLList(html) {
  const shows = [];
  const seen = new Set();
  const linkRe = /<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const url = toAbs(m[1]);
    if (!url || !/https?:\/\/www\.whatnot\.com\/live\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const a = m[0];
    const title =
      /aria-label=["']([^"']+)["']/i.exec(a)?.[1]?.trim() ||
      /alt=["']([^"']+)["']/i.exec(a)?.[1]?.trim() ||
      a.replace(/<[^>]*>/g, "").trim() ||
      null;

    const img = /<img[^>]+src=["']([^"']+)["']/i.exec(a)?.[1] || null;

    shows.push({ title, url, image: img, start_at: null });
  }
  return shows;
}

// ---------- Startzeit aus Detailseite ----------
function extractStartFromNextData(nextData) {
  let iso = null, title = null, image = null;
  walk(nextData, (_k, v) => {
    if (v && typeof v === "object") {
      if (!iso)
        iso = pick(v, ["startAt", "start_at", "startsAt", "scheduled_start_time", "scheduledStartAt", "startDate"]);
      if (!title) title = pick(v, ["title", "name"]);
      if (!image) image = pick(v, ["image", "coverImage", "cover_image_url", "thumbnail", "img", "ogImage"]);
    }
  });
  return { iso, title, image };
}
function extractStartFromJSONLD(ld) {
  for (const block of ld) {
    const arr = Array.isArray(block) ? block : [block];
    for (const item of arr) {
      const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
      if (types?.includes("Event") && item.startDate) {
        return { iso: item.startDate, title: item.name || null, image: (Array.isArray(item.image) ? item.image[0] : item.image) || null };
      }
    }
  }
  return { iso: null, title: null, image: null };
}
function extractStartFromMeta(html) {
  const title = getMeta(html, "og:title") || getMeta(html, "twitter:title") || null;
  const image = getMeta(html, "og:image") || getMeta(html, "twitter:image") || null;
  const ld = extractJSONLD(html);
  const fromLD = extractStartFromJSONLD(ld);
  return { iso: fromLD.iso, title: title || fromLD.title, image: image || fromLD.image };
}

async function fetchWithTimeout(url, ms, parentSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

async function enrich(show, parentSignal) {
  try {
    const r = await fetchWithTimeout(show.url, DETAIL_TIMEOUT_MS, parentSignal);
    const html = await r.text();

    let iso = null, title = null, image = null;

    const next = extractNextData(html);
    if (next) {
      const d = extractStartFromNextData(next);
      iso = d.iso || iso;
      title = d.title || title;
      image = d.image || image;
    }
    if (!iso || !image || !title) {
      const d = extractStartFromMeta(html);
      iso = d.iso || iso;
      title = d.title || title;
      image = d.image || image;
    }

    return {
      title: title || show.title || null,
      url: show.url,
      image: image || show.image || null,
      start_at: iso || null,
    };
  } catch {
    // im Fehlerfall ursprüngliche Show zurückgeben
    return show;
  }
}

async function enrichAll(shows, parentSignal) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < shows.length) {
      const idx = i++;
      out[idx] = await enrich(shows[idx], parentSignal);
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
  const limit = toInt(req.query.limit, DEFAULT_LIMIT);

  const profileUrl = `https://www.whatnot.com/user/${encodeURIComponent(username)}/shows`;

  const globalAbort = new AbortController();
  const kill = setTimeout(() => globalAbort.abort(), TOTAL_BUDGET_MS);

  try {
    // Profilseite laden
    const pr = await fetch(profileUrl, {
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "de-DE,de;q=0.9" },
      redirect: "follow",
      signal: globalAbort.signal,
    });
    const html = await pr.text();

    // Shows extrahieren
    let shows = [];
    const next = extractNextData(html);
    if (next) shows = fromNextDataList(next);
    if (!shows.length) shows = fromHTMLList(html);

    // limitieren
    shows = shows.slice(0, limit);

    // Startzeiten aus Detailseiten holen
    const data = await enrichAll(shows, globalAbort.signal);

    // nur die gewünschten 4 Felder liefern
    return res.status(200).json({
      user: username,
      shows: data.map(({ title, url, image, start_at }) => ({
        title: title || null,
        url,
        image: image || null,
        start_at: start_at || null, // ISO-String wenn gefunden
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(kill);
  }
}
