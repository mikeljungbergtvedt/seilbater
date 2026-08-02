import { fetch } from "undici";
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchViaHttp(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,no;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Ch-Ua": '"Chromium";v="126", "Not?A_Brand";v="8", "Google Chrome";v="126"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });
  if (res.status === 404) return { status: 404, html: "" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, html: await res.text() };
}

/* ---------- Parsers ---------- */
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
  const isProduct =
    t === "Product" || (Array.isArray(t) && t.includes("Product")) ||
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
  const priceRaw = meta("product:price:amount") || meta("og:price:amount") || meta("product:price") || meta("og:price");
  const price = toNumber(priceRaw);
  if (price != null) out.price = price;
  const cur = meta("product:price:currency") || meta("og:price:currency");
  if (cur) out.currency = String(cur).toUpperCase();
  const avail = meta("product:availability") || meta("og:availability");
  if (avail) {
    const a = String(avail).toLowerCase();
    if (a.includes("sold")) out.status = "sold";
    else if (a.includes("instock") || a.includes("available")) out.status = "active";
    else if (a.includes("reserved") || a.includes("preorder")) out.status = "reserved";
  }
  return out;
}

const CURRENCY_HINTS = {
  kr: "NOK", nok: "NOK", sek: "SEK", dkk: "DKK",
  "€": "EUR", eur: "EUR", "$": "USD", usd: "USD", "£": "GBP", gbp: "GBP",
};

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
    /(nok|usd|eur|gbp|sek|dkk)\s*([\d][\d\s.,]{2,})/i,
  ];
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (m) {
      const cand = m[1] && /[\d]/.test(m[1]) ? m[1] : m[2];
      const price = toNumber(cand);
      if (price != null && price > 100) {
        out.price = price;
        const window = m[0].toLowerCase();
        for (const [hint, code] of Object.entries(CURRENCY_HINTS)) {
          if (window.includes(hint)) { out.currency = code; break; }
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
    n = parts[parts.length - 1].length === 2
      ? parseFloat(s.replace(/,(?=\d{2}$)/, ".").replace(/,/g, ""))
      : parseFloat(s.replace(/,/g, ""));
  } else if (hasDot) {
    const parts = s.split(".");
    n = parts[parts.length - 1].length === 2
      ? parseFloat(s.replace(/\.(?=\d{2}$)/, "D").replace(/\./g, "").replace("D", "."))
      : parseFloat(s.replace(/\./g, ""));
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

export async function scrapeUrl(url) {
  const res = await fetchViaHttp(url);
  if (res.status === 404) return { status: "removed", parseFailed: false };
  const html = res.html;
  const $ = cheerio.load(html);
  const layers = [
    ["jsonld", parseJsonLd($)],
    ["opengraph", parseOpenGraph($)],
    ["heuristic", parseHeuristic($, html)],
  ];
  const acc = {};
  for (const [source, data] of layers) {
    for (const key of ["title", "price", "currency", "status", "adLastUpdated", "image"]) {
      if (acc[key] == null && data[key] != null && data[key] !== "") acc[key] = data[key];
    }
  }
  if (acc.price != null && !acc.status) acc.status = "active";
  if (isInterstitial(html, acc.title)) throw new Error("bot-beskyttelse (kunne ikke passere Cloudflare)");
  if (acc.price == null && !acc.title) throw new Error("fant hverken pris eller tittel");
  return acc;
}

export async function closeBrowser() { /* no-op */ }
