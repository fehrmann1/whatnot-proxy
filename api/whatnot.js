// Node.js Serverless Function (Hobby-Plan: keine Multi-Region)
export const config = {
  runtime: "nodejs"
  // regions: ["fra1"] // optional: eine einzelne Region erlaubt
};

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const username = (req.query.user || "skycard").trim();
  const url = `https://www.whatnot.com/user/${username}/shows`;

  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote",
        "--disable-gpu"
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: true
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);

    // möglichst realistische Header
    await page.setExtraHTTPHeaders({
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    });

    // „echter“ User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );

    // Seite laden
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // --- Anti-Bot-Interstitital abwarten / überspringen ---
    const isInterstitialTitle = (t) =>
      /nur einen moment|just a moment/i.test(t || "");

    // bis zu 2 Versuche (erste Seite + 1 Reload)
    for (let attempt = 0; attempt < 2; attempt++) {
      // bis zu 12 s warten, bis der Titel NICHT mehr "Nur einen Moment…" ist
      let ok = false;
      for (let i = 0; i < 12; i++) {
        const title = await page.title().catch(() => "");
        if (!isInterstitialTitle(title)) {
          ok = true;
          break;
        }
        await sleep(1000);
      }
      if (ok) break;

      // wenn immer noch Interstitital → noch einmal neu laden
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(1500);
    }

    // leichter Scroll (lazy load)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(800);

    // auf mögliche Live-Links warten (still weiter, wenn nicht)
    await page
      .waitForSelector('a[href^="/live/"], a[href*="/live/"]', { timeout: 12000 })
      .catch(() => {});

    // (falls möglich) kurzen Idle abwarten
    try { await page.waitForNetworkIdle({ idleTime: 750, timeout: 8000 }); } catch {}

    await sleep(500);

    // Debug-Infos loggen
    const info = await page.evaluate(() => ({
      title: document.title,
      anchorCount: document.querySelectorAll('a[href^="/live/"], a[href*="/live/"]').length,
      hasNextData: !!document.querySelector("#__NEXT_DATA__")
    }));
    console.log("whatnot page info:", info);

    // Next.js-Daten optional holen
    await page.waitForSelector("#__NEXT_DATA__", { timeout: 5000 }).catch(() => {});
    const nextData = await page.evaluate(() => {
      try {
        const tag = document.querySelector("#__NEXT_DATA__");
        if (tag) return JSON.parse(tag.textContent);
        // eslint-disable-next-line no-undef
        if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
      } catch {}
      return null;
    });
    console.log("has nextData:", !!nextData);

    // --- Extraktion ---
    const shows = [];

    const walk = (o, cb) => {
      if (o && typeof o === "object") {
        for (const k of Object.keys(o)) {
          cb(k, o[k]);
          walk(o[k], cb);
        }
      }
    };

    const pick = (o, keys) =>
      keys.find((k) => o && typeof o[k] === "string" && o[k]) &&
      o[keys.find((k) => o && typeof o[k] === "string" && o[k])];

    if (nextData) {
      const seen = new Set();
      walk(nextData, (k, v) => {
        if (Array.isArray(v)) {
          for (const it of v) {
            const raw = pick(it, ["url", "href", "permalink", "path", "slug"]);
            const title = pick(it, ["title", "name"]);
            const image = pick(it, ["image", "img", "coverImage", "cover_image_url", "thumbnail", "cover"]);
            const start_at = pick(it, ["startAt", "start_at", "startsAt", "scheduled_start_time"]);

            let fullUrl = null;
            if (typeof raw === "string") {
              fullUrl = raw.startsWith("http")
                ? raw
                : `https://www.whatnot.com${raw.startsWith("/") ? "" : "/"}${raw}`;
            }

            if (fullUrl && /https?:\/\/www\.whatnot\.com\/live\//.test(fullUrl)) {
              if (!seen.has(fullUrl)) {
                seen.add(fullUrl);
                shows.push({
                  title: title || "Whatnot Show",
                  url: fullUrl,
                  image: image || null,
                  start_at: start_at || null
                });
              }
            }
          }
        }
      });

      shows.sort(
        (a, b) =>
          (a.start_at ? Date.parse(a.start_at) : Infinity) -
          (b.start_at ? Date.parse(b.start_at) : Infinity)
      );
    }

    if (!shows.length) {
      const domShows = await page.evaluate(() => {
        const results = [];
        const anchors = Array.from(
          document.querySelectorAll('a[href^="/live/"], a[href*="/live/"]')
        );
        for (const a of anchors) {
          const href = a.getAttribute("href");
          if (!href) continue;
          const url = new URL(href, location.origin).toString();

          const img = a.querySelector("img");
          const alt = img?.alt?.trim();
          const aria = a.getAttribute("aria-label")?.trim();
          const text = a.textContent?.trim();
          const title = alt || aria || text || "Whatnot Show";

          let image = img?.src || img?.getAttribute("data-src") || null;
          if (!image && img?.srcset) {
            image = img.srcset.split(",").map(s => s.trim().split(" ")[0])[0] || null;
          }

          results.push({ title, url, image, start_at: null });
        }
        const seen = new Set();
        return results.filter(s => !seen.has(s.url) && seen.add(s.url)).slice(0, 12);
      });

      shows.push(...domShows);
    }

    console.log("extracted shows:", shows.length);

    try { await browser.close(); } catch {}
    return res.status(200).json({ user: username, shows: shows.slice(0, 12) });
  } catch (e) {
    try { if (browser) await browser.close(); } catch {}
    console.error("whatnot error:", e);
    return res.status(500).json({ error: String(e) });
  }
}
