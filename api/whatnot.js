// api/whatnot.js
// Erweiterter Endpoint: Liste + optionale Detail-Anreicherung (ohne Puppeteer)

export const config = {
  runtime: "nodejs",
};

// ---------- Defaults / Tuning ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

// Globales Zeitbudget
const TOTAL_BUDGET_MS = 15000;
// Timeout pro Detailseite
const DETAIL_TIMEOUT_MS = 3500;

// Fallback-Defaults
const DEFAULT_LIMIT = 8;
const DEFAULT_CONCURRENCY = 4;

// ---------- Utils ----------
const now = () => Date.now();

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

function extractBetween(re, text) {
  const m = re.exec(text);
  return m ? m[1] : null;
}

function toAbs(url) {
  if (!url) return null;
  return url.startsWith("http")
    ? url
    : `https://www.whatnot.com${url.startsWith("/") ? "" : "/"}${url}`;
}

function getMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return re.exec(html)?.[1] || null;
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
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {}
  }
  return out;
}

function parsePriceHints(text) {
  if (!text) return { price_hint: null, currency: null };
  // "Startet bei 1 €", "ab 3,50 EUR", etc.
  const m =
    /(?:ab|bei|from)?\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*(€|eur)/i.exec(text);
  if (!m) return { price_hint: null, currency: null };
  const value = m[1].replace(",", ".");
  return { price_hint: Number(value), currency: "EUR" };
}

function computeStatus(hasLiveFlag, startIso) {
  if (hasLiveFlag) return "live";
  if (startIso) {
    const t = Date.parse(startIso);
    if (Number.isFinite(t) && t > now()) return "upcoming";
  }
  return "unknown";
}

// ---------- Übersicht von Profilseite ----------
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
        if (!fullUrl) continue;

        if (/https?:\/\/www\.whatnot\.com\/live\//i.test(fullUrl) && !seen.has(fullUrl)) {
          seen.add(fullUrl);

          const id =
            extractBetween(/\/live\/([^/?#]+)/i, fullUrl) ||
            extractBetween(/\/live\/(.+)$/i, fullUrl);

          const priceInfo = parsePriceHints(title);

          shows.push({
            id: id || null,
            title: title || null,
            url: fullUrl,
            image: image || null,
            start_at_iso: start_at || null,
            starts_in_ms: start_at ? (Date.parse(start_at) - now()) : null,
            status: "unknown",
            ...priceInfo,
          });
        }
      }
    }
  });

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

    const id =
      extractBetween(/\/live\/([^/?#]+)/i, abs) ||
      extractBetween(/\/live\/(.+)$/i, abs);

    const priceInfo = parsePriceHints(aria || alt || text);

    shows.push({
      id: id || null,
      title: aria || alt || text || null,
      url: abs,
      image: null,
      start_at_iso: null,
      starts_in_ms: null,
      status: "unknown",
      ...priceInfo,
    });
  }

  return shows;
}

// ---------- Details je Show ----------
function detailFromNextData(nextData) {
  let title = null,
    image = null,
    start_at_iso = null,
    isLive = false;

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
      if (!start_at_iso)
        start_at_iso = pick(v, [
          "startAt",
          "start_at",
          "startsAt",
          "scheduled_start_time",
          "scheduledStartAt",
          "startDate",
        ]);
      if (!isLive && typeof v.isLive === "boolean") isLive = v.isLive;
    }
  });

  return { title, image, start_at_iso, isLive };
}

function detailFromJSONLD(ldBlocks) {
  for (const block of ldBlocks) {
    const list = Array.isArray(block) ? block : [block];
    for (const item of list) {
      const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
      if (types?.includes("Event")) {
        const title = item.name || null;
        const start_at_iso = item.startDate || null;
        const image = (Array.isArray(item.image) ? item.image[0] : item.image) || null;
        return { title, image, start_at_iso, isLive: false };
      }
    }
  }
  return { title: null, image: null, start_at_iso: null, isLive: false };
}

function detailFromMeta(html) {
  const title = getMeta(html, "og:title") || getMeta(html, "twitter:title") || null;
  const image = getMeta(html, "og:image") || getMeta(html, "twitter:image") || null;

  const ld = extractJSONLD(html);
  const fromLD = detailFromJSONLD(ld);
  return {
    title: title || fromLD.title,
    image: image || fromLD.image,
    start_at_iso: fromLD.start_at_iso,
    isLive: fromLD.isLive,
  };
}

async function fetchWithTimeout(url, ms, abortParent) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  const onAbort = () => controller.abort();
  abortParent?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
    abortParent?.removeEventListener("abort", onAbort);
  }
}

async function enrichShow(show, parentAbort) {
  try {
    const r = await fetchWithTimeout(show.url, DETAIL_TIMEOUT_MS, parentAbort);
    const html = await r.text();

    let d = { title: null, image: null, start_at_iso: null, isLive: false };

    const next = extractNextData(html);
    if (next) d = detailFromNextData(next);

    if (!d.title || !d.image || !d.start_at_iso) {
      const more = detailFromMeta(html);
      d = {
        title: d.title || more.title,
        image: d.image || more.image,
        start_at_iso: d.start_at_iso || more.start_at_iso,
        isLive: d.isLive || more.isLive,
      };
    }

    const status = computeStatus(d.isLive, d.start_at_iso);
    const priceInfo = parsePriceHints(d.title || show.title);

    return {
      ...show,
      title: d.title || show.title,
      image: d.image || show.image,
      start_at_iso: d.start_at_iso || show.start_at_iso,
      starts_in_ms: d.start_at_iso ? (Date.parse(d.start_at_iso) - now()) : show.starts_in_ms,
      status,
      price_hint: priceInfo.price_hint ?? show.price_hint,
      currency: priceInfo.currency ?? show.currency,
    };
  } catch {
    // Bei Fehlern die Rohversion zurückgeben
    return show;
  }
}

async function enrichAll(shows, parentAbort, concurrency) {
  const out = [];
  let i = 0;

  async function worker() {
    while (i < shows.length) {
      const idx = i++;
      out[idx] = await enrichShow(shows[idx], parentAbort);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, shows.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const username = String(req.query.user || "skycard").trim();
  const limit = toInt(req.query.limit, DEFAULT_LIMIT);
  const details = String(req.query.details ?? "1") !== "0";
  const concurrency = toInt(req.query.concurrency, DEFAULT_CONCURRENCY);

  const profileUrl = `https://www.whatnot.com/user/${encodeURIComponent(username)}/shows`;

  const globalAbort = new AbortController();
  const kill = setTimeout(() => globalAbort.abort(), TOTAL_BUDGET_MS);

  try {
    // 1) Profilseite
    const pr = await fetch(profileUrl, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: globalAbort.signal,
    });

    const html = await pr.text();

    // 2) Liste extrahieren
    let shows = [];
    const next = extractNextData(html);
    if (next) shows = extractFromNextDataList(next);
    if (!shows.length) shows = extractFromHTMLList(html);

    // 3) limitieren
    shows = shows.slice(0, limit);

    // 4) Details optional anreichern
    let data = shows;
    if (details && shows.length) {
      data = await enrichAll(shows, globalAbort.signal, concurrency);
    }

    // 5) sortiere: live zuerst, dann nach Startzeit
    data.sort((a, b) => {
      const rank = (s) => (s.status === "live" ? 0 : s.starts_in_ms != null && s.starts_in_ms > 0 ? 1 : 2);
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const ta = Number.isFinite(a.starts_in_ms) ? a.starts_in_ms : Infinity;
      const tb = Number.isFinite(b.starts_in_ms) ? b.starts_in_ms : Infinity;
      return ta - tb;
    });

    return res.status(200).json({
      meta: {
        fetched_at: new Date().toISOString(),
        user: username,
        requested: { limit, details, concurrency },
        returned: data.length,
      },
      user: username,
      shows: data,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  } finally {
    clearTimeout(kill);
  }
}
