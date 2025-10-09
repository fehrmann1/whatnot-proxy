export const config = {
  runtime: "nodejs",          // <— statt "nodejs20"
  regions: ["fra1"]
};

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const username = (req.query.user || "skycard").trim();
  const url = `https://www.whatnot.com/user/${username}/shows`;

  chromium.setHeadlessMode(true);
  chromium.setGraphicsMode("basic");

  let browser;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#__NEXT_DATA__", { timeout: 10000 }).catch(() => {});

    const nextData = await page.evaluate(() => {
      try {
        const tag = document.querySelector("#__NEXT_DATA__");
        if (tag) return JSON.parse(tag.textContent);
        // eslint-disable-next-line no-undef
        if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
      } catch {}
      return null;
    });

    const shows = [];
    const walk = (o, cb) => { if (o && typeof o === "object") for (const k of Object.keys(o)) { cb(k, o[k]); walk(o[k], cb); } };
    const pick = (o, keys) => keys.find(k => o && typeof o[k] === "string" && o[k]) && o[keys.find(k => o && typeof o[k] === "string" && o[k])];

    if (nextData) {
      const seen = new Set();
      walk(nextData, (k, v) => {
        if (Array.isArray(v)) {
          for (const it of v) {
            const raw = pick(it, ["url","href","permalink","path","slug"]);
            const title = pick(it, ["title","name"]);
            const image = pick(it, ["image","img","coverImage","cover_image_url","thumbnail","cover"]);
            const start_at = pick(it, ["startAt","start_at","startsAt","scheduled_start_time"]);
            let fullUrl = null;
            if (typeof raw === "string") fullUrl = raw.startsWith("http") ? raw : `https://www.whatnot.com${raw.startsWith("/")?"":"/"}${raw}`;
            if (fullUrl && /https?:\/\/www\.whatnot\.com\/live\//.test(fullUrl) && !seen.has(fullUrl)) {
              seen.add(fullUrl);
              shows.push({ title: title || "Whatnot Show", url: fullUrl, image: image || null, start_at: start_at || null });
            }
          }
        }
      });
      shows.sort((a,b)=>(a.start_at?Date.parse(a.start_at):Infinity)-(b.start_at?Date.parse(b.start_at):Infinity));
    }

    if (!shows.length) {
      const domShows = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href^="/live/"]').forEach(a => {
          const url = new URL(a.getAttribute("href"), location.origin).toString();
          const img = a.querySelector("img");
          const title = (img?.alt) || a.getAttribute("aria-label") || "Whatnot Show";
          out.push({ title, url, image: img?.src || null, start_at: null });
        });
        const seen = new Set();
        return out.filter(s => !seen.has(s.url) && seen.add(s.url)).slice(0,12);
      });
      shows.push(...domShows);
    }

    await browser.close().catch(()=>{});
    return res.status(200).json({ user: username, shows: shows.slice(0,12) });
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    return res.status(500).json({ error: String(e) });
  }
}
