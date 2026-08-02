// Seilbåter — lokal scraper.
// Kjører Playwright med Chromium på din egen mac (residential IP → passerer
// Cloudflare på Yachtworld/Boat24). Leser båter fra samme Neon-database
// som Vercel-siden bruker, oppdaterer resultater, sender mail ved endringer.

import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

const sql = neon(process.env.DATABASE_URL);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BROWSER_DOMAINS = /yachtworld\.com|boat24\.com|boattrader\.com|batagent\.se|finn\.no|blocket\.se/i;

/* ---------------- Fetch ---------------- */
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return _browser;
}

async function fetchViaBrowser(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Europe/Oslo",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);
    try {
      await page.waitForFunction(
        () => !document.title.toLowerCase().includes("just a moment") &&
              !document.title.toLowerCase().includes("one moment"),
        { timeout: 8000 }
      );
    } catch {}
    return await page.content();
  } finally {
    await context.close();
  }
}

async function fetchViaHttp(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,no;q=0.8",
    },
    redirect: "follow",
  });
  if (res.status === 404) return { status: 404, html: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, html: await res.text() };
}

/* ---------------- Parsers (samme som Vercel-versjonen) ---------------- */
function parseJsonLd($) {
  const out = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) walkJsonLd(node, out);
  });
  return out;
}
function walkJsonLd(node, out) {
  if (!node || typeof node !== "object") return;
  const t = node["@type"];
  const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product")) ||
    t === "Vehicle" || (Array.isArray(t) && t.includes("Vehicle"));
  if (isProduct) {
    if (!out.title && typeof node.name === "string") out.title = node.name.trim();
    if (!out.image) {
      const img = node.image;
      if (typeof img === "string") out.image = img;
      else if (Array.isArray(img) && img.length) out.image = typeof img[0] === "string" ? img[0] : img[0]?.url;
      else if (img && typeof img === "object") out.image = img.url;
    }
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    if (offers && typeof offers === "object") {
      if (out.price == null) {
        const p = offers.price ?? offers.lowPrice ?? offers.highPrice;
        const n = toNumber(p);
        if (n != null) out.price = n;
      }
      if (!out.currency && typeof offers.priceCurrency === "string") out.currency = offers.priceCurrency.toUpperCase();
      if (!out.status) {
        const av = String(offers.availability || "").toLowerCase();
        if (av.includes("soldout") || av.includes("sold")) out.status = "sold";
        else if (av.includes("instock") || av.includes("available")) out.status = "active";
        else if (av.includes("preorder") || av.includes("reserved")) out.status = "reserved";
      }
    }
    if (!out.adLastUpdated && typeof node.dateModified === "string") out.adLastUpdated = node.dateModified;
  }
  if (node["@graph"] && Array.isArray(node["@graph"])) for (const g of node["@graph"]) walkJsonLd(g, out);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object" && k !== "@graph") walkJsonLd(v, out);
  }
}

function parseOpenGraph($) {
  const out = {};
  const meta = (name, prop = "property") => $(`meta[${prop}="${name}"]`).attr("content");
  const title = meta("og:title") || meta("og:title", "name");
  if (title) out.title = title.trim();
  const image = meta("og:image") || meta("og:image:secure_url") || meta("twitter:image", "name");
  if (image) out.image = image.trim();
  const priceRaw = meta("product:price:amount") || meta("og:price:amount");
  const price = toNumber(priceRaw);
  if (price != null) out.price = price;
  const cur = meta("product:price:currency") || meta("og:price:currency");
  if (cur) out.currency = String(cur).toUpperCase();
  const avail = meta("product:availability") || meta("og:availability");
  if (avail) {
    const a = String(avail).toLowerCase();
    if (a.includes("sold")) out.status = "sold";
    else if (a.includes("instock") || a.includes("available")) out.status = "active";
    else if (a.includes("reserved")) out.status = "reserved";
  }
  return out;
}

function parseHeuristic($, rawHtml) {
  const out = {};
  const t = $("title").first().text();
  if (t) out.title = t.trim();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const lower = bodyText.toLowerCase();
  if (/\b(sold|solgt|no longer available|annonse fjernet)\b/.test(lower)) out.status = "sold";
  else if (/\b(reserved|reservert|sale pending|pending sale|under bud)\b/.test(lower)) out.status = "reserved";
  const patterns = [
    /(?:us\$|\$|€|£)\s*([\d][\d\s.,]{2,})/i,
    /([\d][\d\s.,]{2,})\s*(kr|nok|usd|eur|gbp|sek|dkk|\$|€|£)/i,
  ];
  const CURRENCY = { kr: "NOK", nok: "NOK", sek: "SEK", dkk: "DKK", "€": "EUR", eur: "EUR", "$": "USD", usd: "USD", "£": "GBP", gbp: "GBP" };
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (m) {
      const cand = m[1] && /[\d]/.test(m[1]) ? m[1] : m[2];
      const price = toNumber(cand);
      if (price != null && price > 100) {
        out.price = price;
        for (const [hint, code] of Object.entries(CURRENCY)) {
          if (m[0].toLowerCase().includes(hint)) { out.currency = code; break; }
        }
        break;
      }
    }
  }
  return out;
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/[^\d.,\-]/g, "").trim();
  if (!s) return null;
  let n;
  const hasComma = s.includes(","), hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    else n = parseFloat(s.replace(/,/g, ""));
  } else if (hasComma) {
    const parts = s.split(",");
    n = parts[parts.length - 1].length === 2 ? parseFloat(s.replace(/,(?=\d{2}$)/, ".").replace(/,/g, "")) : parseFloat(s.replace(/,/g, ""));
  } else if (hasDot) {
    const parts = s.split(".");
    n = parts[parts.length - 1].length === 2 ? parseFloat(s.replace(/\.(?=\d{2}$)/, "D").replace(/\./g, "").replace("D", ".")) : parseFloat(s.replace(/\./g, ""));
  } else n = parseFloat(s);
  return isFinite(n) ? Math.round(n) : null;
}

function isInterstitial(html, title) {
  const t = (title || "").toLowerCase();
  const patterns = ["one moment", "just a moment", "checking your browser", "verifying you are human", "attention required", "cloudflare", "access denied", "captcha"];
  if (patterns.some(p => t.includes(p))) return true;
  const sample = html.slice(0, 5000).toLowerCase();
  return sample.includes("cf-browser-verification") || sample.includes("checking if the site connection is secure");
}

async function scrapeUrl(url) {
  const useBrowser = BROWSER_DOMAINS.test(url);
  const res = useBrowser
    ? { status: 200, html: await fetchViaBrowser(url) }
    : await fetchViaHttp(url);
  if (res.status === 404) return { status: "removed" };
  const html = res.html;
  const $ = cheerio.load(html);
  const acc = {};
  for (const data of [parseJsonLd($), parseOpenGraph($), parseHeuristic($, html)]) {
    for (const key of ["title", "price", "currency", "status", "adLastUpdated", "image"]) {
      if (acc[key] == null && data[key] != null && data[key] !== "") acc[key] = data[key];
    }
  }
  if (acc.price != null && !acc.status) acc.status = "active";
  if (isInterstitial(html, acc.title)) throw new Error("bot-beskyttelse (kunne ikke passere Cloudflare)");
  if (acc.price == null && !acc.title) throw new Error("fant hverken pris eller tittel");
  return acc;
}

/* ---------------- Main ---------------- */
async function main() {
  const boats = await sql`SELECT * FROM boats`;
  console.log(`[scraper] Sjekker ${boats.length} båter…`);
  const events = [];

  for (const boat of boats) {
    process.stdout.write(`  ${boat.url.slice(0, 70)}… `);
    try {
      const data = await scrapeUrl(boat.url);
      const now = new Date();
      const history = boat.history || [];
      let lastChangeAt = boat.last_change_at;
      let prevPrice = boat.prev_price;

      if (data.price != null && boat.price != null && data.price !== boat.price) {
        prevPrice = boat.price;
        lastChangeAt = now;
        history.push({ at: now.toISOString(), type: "price", from: boat.price, to: data.price });
        events.push({ kind: "price", url: boat.url, title: data.title || boat.title, from: boat.price, to: data.price, currency: data.currency || boat.currency });
      }
      const alertStatuses = new Set(["sold", "reserved", "removed"]);
      if (data.status && boat.status && data.status !== boat.status && alertStatuses.has(data.status)) {
        lastChangeAt = now;
        history.push({ at: now.toISOString(), type: "status", from: boat.status, to: data.status });
        events.push({ kind: "status", url: boat.url, title: data.title || boat.title, from: boat.status, to: data.status });
      }

      await sql`
        UPDATE boats SET
          title = COALESCE(${data.title || null}, title),
          price = COALESCE(${data.price ?? null}, price),
          prev_price = ${prevPrice ?? null},
          currency = COALESCE(${data.currency || null}, currency),
          status = COALESCE(${data.status || null}, status),
          image = COALESCE(${data.image || null}, image),
          ad_last_updated = COALESCE(${data.adLastUpdated || null}, ad_last_updated),
          last_checked_at = ${now.toISOString()},
          last_change_at = ${lastChangeAt ? new Date(lastChangeAt).toISOString() : null},
          parse_failed = FALSE,
          last_error = NULL,
          history = ${JSON.stringify(history)}::jsonb
        WHERE id = ${boat.id}
      `;
      console.log("OK");
    } catch (err) {
      await sql`
        UPDATE boats SET
          parse_failed = TRUE,
          last_error = ${err.message},
          last_checked_at = NOW()
        WHERE id = ${boat.id}
      `;
      console.log("FEIL:", err.message);
    }
  }

  if (_browser) { try { await _browser.close(); } catch {} }

  console.log(`[scraper] Ferdig. ${events.length} endring(er).`);
  if (events.length > 0) {
    await sendMail(events);
    console.log("[mail] Sendt.");
  }
}

async function sendMail(events) {
  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  const to = process.env.MAIL_TO;
  if (!user || !pass || !to) { console.warn("[mail] MAIL_* mangler — hopper over"); return; }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
  });
  const dateStr = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "short", year: "numeric" });
  const subject = `Seilbåter — ${events.length} endring${events.length === 1 ? "" : "er"} ${dateStr}`;
  const fmt = (n, cur) => n == null ? "—" : new Intl.NumberFormat("nb-NO").format(n) + (cur ? " " + cur : "");
  const rows = events.map(ev => {
    if (ev.kind === "price") {
      const dir = ev.to < ev.from ? "ned" : "opp";
      const color = ev.to < ev.from ? "#1a7f37" : "#bf8700";
      const diff = ev.to - ev.from;
      const diffStr = (diff > 0 ? "+" : "") + fmt(diff, ev.currency);
      return `<div style="border:1px solid #e2e5e9;border-radius:8px;padding:14px;margin-bottom:10px;font-family:sans-serif;">
        <div style="font-size:11px;color:${color};text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px;">Pris ${dir}</div>
        <div style="margin-bottom:10px;"><a href="${ev.url}" style="font-weight:600;color:#0969da;text-decoration:none;font-size:15px;">${ev.title}</a></div>
        <table style="border-collapse:collapse;font-size:14px;">
          <tr><td style="color:#57606a;padding:2px 12px 2px 0;">Før:</td><td>${fmt(ev.from, ev.currency)}</td></tr>
          <tr><td style="color:#57606a;padding:2px 12px 2px 0;">Etter:</td><td style="font-weight:700;">${fmt(ev.to, ev.currency)}</td></tr>
          <tr><td style="color:#57606a;padding:2px 12px 2px 0;">Endring:</td><td style="color:${color};font-weight:700;">${diffStr}</td></tr>
        </table>
      </div>`;
    } else {
      const color = ev.to === 'sold' ? '#cf222e' : '#8250df';
      return `<div style="border:1px solid #e2e5e9;border-radius:8px;padding:14px;margin-bottom:10px;font-family:sans-serif;">
        <div style="font-size:11px;color:${color};text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px;">Status endret</div>
        <div style="margin-bottom:10px;"><a href="${ev.url}" style="font-weight:600;color:#0969da;text-decoration:none;font-size:15px;">${ev.title}</a></div>
        <table style="border-collapse:collapse;font-size:14px;">
          <tr><td style="color:#57606a;padding:2px 12px 2px 0;">Før:</td><td>${ev.from}</td></tr>
          <tr><td style="color:#57606a;padding:2px 12px 2px 0;">Etter:</td><td style="font-weight:700;">${ev.to}</td></tr>
        </table>
      </div>`;
    }
  }).join("");
  await transport.sendMail({
    from: user, to, subject,
    html: `<div style="font-family:sans-serif;background:#f6f8fa;padding:20px;">
      <div style="max-width:640px;margin:auto;background:#fff;border-radius:10px;padding:20px;">
        <h2>Seilbåter — endringer</h2>
        <p style="color:#57606a;">${events.length} endring${events.length === 1 ? "" : "er"} siden sist.</p>
        ${rows}
      </div></div>`,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
