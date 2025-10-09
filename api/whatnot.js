// api/whatnot.js

export const config = {
  runtime: "nodejs",
  // regions: ["fra1"], // optional: nur eine Region im Hobby-Plan
};

import chromium from "@sparticuz/chromium";
import puppeteerCore from "puppeteer-core";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// --- Puppeteer + Stealth vorbereiten (problematische Evasions deaktivieren) ---
const puppeteer = addExtra(puppeteerCore);
const stealth = StealthPlugin();

// Sämtliche Evasions, die mit "chrome." beginnen, deaktivieren
for (const name of Array.from(stealth.enabledEvasions.keys())) {
  if (name.startsWith("chrome.")) {
    stealth.enabledEvasions.delete(name);
  }
}

// (Optional) weitere Evasions gezielt abschalten, falls nötig
// stealth.enabledEvasions.delete("iframe.contentWindow");
// stealth.enabledEvasions.delete("media.codecs");

puppeteer.use(stealth);


// ------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// Hartes internes Zeitbudget, damit wir verlässlich vor dem Vercel-Timeout antworten
const BUDGET_MS = 20000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const username = (req.query.user || "skycard").trim();
  const url = `https://www.whatnot.com/user/${encodeURIComponent(username)}/shows`;

  const deadline = now() + BUDGET_MS;
  const withinBudget = () => Math.max(0, deadline - now());

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
        "--disable-gpu",
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Aggressiv Ressourcen sparen → schneller, weniger auffällig
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) req.abort();
      else req.continue();
    });

    page.setDefaultNavigationTimeout(Math.min(60000, withinBudget()));
    page.setDefaultTimeout(Math.min(30000, Math.max(2000, withinBudget())));

    // Realistische Header
    await page.setExtraHTTPHeaders({
      "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });

    // UA – Stealth kümmert sich um navigator.webdriver, WebGL, usw.
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );

    // Initiales Laden
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(2000, withinBudget()),
    });

    const isInterstitialTitle = (t) =>
      /nur einen moment|just a moment/i.test(t || "");

    // Interstitial nur kurz tolerieren (max. 1 Reload)
    for (let attempt = 0; attempt < 2 && withinBudget() > 0; attempt++) {
      let ok = false;
      const rounds = Math.min(8, Math.ceil(withinBudget() / 800));
      for (let i = 0; i < rounds; i++) {
        const title = await page.title().catch(() => "");
        if (!isInterstitialTitle(title)) {
          ok = true;
          break;
        }
        await sleep(800);
        if (withinBudget() <= 0) break;
      }
      if (ok) break;
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(600);
    }

    // Kleines Scrollen → evtl. lazy-load antriggern
    await page
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => {});
    await sleep(300);

    // Kurz auf /live/-Links warten, ohne zu hängen
    await page
      .waitForSelector('a[href^="/live/"], a[href*="/live/"]', {
        timeout: Math.min(3000, Math.max(500, withinBudget())),
      })
      .catch(() => {});

    try {
      await page.waitForNetworkIdle({
        idleTime: 500,
        timeout: Math.min(2000, withinBudget()),
      });
    } catch {}

    // Debug in Logs
    const info = await page
      .evaluate(() => ({
        title: document.title,
        anchorCount: document.querySelectorAll(
          'a[href^="/live/"], a[href*="/live/"]'
        ).length,
        hasNextData: !!document.querySelector("#__NEXT_DATA__"),
      }))
      .catch(() => ({ title: "", anchorCount: 0, hasNextData: false }));
    console.log("whatnot page info:", info);

    // __NEXT_DATA__ optional (kurz) – wenn vorhanden, nutzen wir sie
    await page
      .waitForSelector("#__NEXT_DATA__", {
        timeout: Math.min(1500, withinBudget()),
      })
      .catch(() => {});
    const nextData = await page
      .evaluate(() => {
        try {
          const tag = document.querySelector("#__NEXT_DATA__");
          if (tag) return JSON.parse(tag.textContent);
          // eslint-disable-next-line no-undef
          if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
        } catch {}
        return null;
      })
      .catch(() => null);
    console.log("has nextData:", !!nextData);

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

    // 1) Extraktion aus Next.js JSON
    if (nextData && withinBudget() > 0) {
      const seen = new Set();
      walk(nextData, (k, v) => {
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

            if (fullUrl && /https?:\/\/www\.whatnot\.com\/live\//.test(fullUrl)) {
              if (!seen.has(fullUrl)) {
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
        }
      });

      shows.sort(
        (a, b) =>
          (a.start_at ? Date.parse(a.start_at) : Infinity) -
          (b.start_at ? Date.parse(b.start_at) : Infinity)
      );
    }

    // 2) Fallback: DOM-Anker parsen
    if (!shows.length && withinBudget() > 0) {
      const domShows = await page
        .evaluate(() => {
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

            results.push({ title, url, image: null, start_at: null });
          }
          const seen = new Set();
          return results
            .filter((s) => !seen.has(s.url) && seen.add(s.url))
            .slice(0, 12);
        })
        .catch(() => []);
      shows.push(...domShows);
    }

    console.log("extracted shows:", shows.length);

    try {
      await browser.close();
    } catch {}

    return res.status(200).json({ user: username, shows: shows.slice(0, 12) });
  } catch (e) {
    try {
      if (browser) await browser.close();
    } catch {}
    console.error("whatnot error:", e);
    return res.status(500).json({ error: String(e) });
  }
}
