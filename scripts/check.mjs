// Seilbåter — daglig sjekk av annonser
// Kjøres av GitHub Action én gang i døgnet.
// Strategi: JSON-LD -> OpenGraph -> heuristikk. Ingen per-portal parser.

import { readFileSync, writeFileSync } from "node:fs";
import { fetch } from "undici";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

const BOATS_FILE = new URL("../boats.json", import.meta.url);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const RATE_MS = 2000;
const MAX_RETRIES = 1;

function log(...args) { console.log("[check]", ...args); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function uid() { return "b_" + Math.random().toString(36).slice(2, 10); }

/* ---------------- Fetch ---------------- */
async function fetchHtml(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,no;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
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
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      return { status: res.status, html };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(1500);
    }
  }
  throw lastErr;
}

/* ---------------- Parsers ---------------- */
function parseJsonLd($) {
  const out = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      walkJsonLd(node, out);
    }
  });
  return out;
}
function walkJsonLd(node, out) {
  if (!node || typeof node !== "object") return;
  const t = node["@type"];
  const isProduct =
    t === "Product" ||
    (Array.isArray(t) && t.includes("Product")) ||
    t === "Vehicle" ||
    (Array.isArray(t) && t.includes("Vehicle"));
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
      if (!out.currency && typeof offers.priceCurrency === "string") {
        out.currency = offers.priceCurrency.toUpperCase();
      }
      if (!out.status) {
        const av = String(offers.availability || "").toLowerCase();
        if (av.includes("soldout") || av.includes("sold")) out.status = "sold";
        else if (av.includes("instock") || av.includes("available")) out.status = "active";
        else if (av.includes("preorder") || av.includes("reserved")) out.status = "reserved";
      }
    }
    if (!out.adLastUpdated && typeof node.dateModified === "string") {
      out.adLastUpdated = node.dateModified;
    }
  }
  // Nested @graph
  if (node["@graph"] && Array.isArray(node["@graph"])) {
    for (const g of node["@graph"]) walkJsonLd(g, out);
  }
  // Nested objects (mainEntity etc)
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object" && k !== "@graph") walkJsonLd(v, out);
  }
}

function parseOpenGraph($) {
  const out = {};
  const meta = (name, prop = "property") =>
    $(`meta[${prop}="${name}"]`).attr("content");

  const title = meta("og:title") || meta("og:title", "name");
  if (title) out.title = title.trim();

  const image = meta("og:image") || meta("og:image:secure_url") || meta("twitter:image", "name");
  if (image) out.image = image.trim();

  const priceRaw =
    meta("product:price:amount") ||
    meta("og:price:amount") ||
    meta("product:price") ||
    meta("og:price");
  const price = toNumber(priceRaw);
  if (price != null) out.price = price;

  const cur =
    meta("product:price:currency") ||
    meta("og:price:currency");
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
  kr: "NOK", "nok": "NOK", "sek": "SEK", "dkk": "DKK",
  "€": "EUR", "eur": "EUR",
  "$": "USD", "usd": "USD",
  "£": "GBP", "gbp": "GBP",
};

function parseHeuristic($, rawHtml) {
  const out = {};
  // Title fallback
  const t = $("title").first().text();
  if (t) out.title = t.trim();

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const lower = bodyText.toLowerCase();

  // Status keywords
  const soldRe = /\b(sold|solgt|no longer available|annonse fjernet)\b/;
  const reservedRe = /\b(reserved|reservert|sale pending|pending sale|under bud)\b/;
  if (soldRe.test(lower)) out.status = "sold";
  else if (reservedRe.test(lower)) out.status = "reserved";

  // Price heuristic — find a currency-flanked number.
  // Patterns like: "$185,000" / "185,000 USD" / "1 850 000 kr" / "€ 120.000"
  const patterns = [
    /(?:us\$|\$|€|£)\s*([\d][\d\s.,]{2,})/i,
    /([\d][\d\s.,]{2,})\s*(kr|nok|usd|eur|gbp|sek|dkk|\$|€|£)/i,
    /(nok|usd|eur|gbp|sek|dkk)\s*([\d][\d\s.,]{2,})/i,
    /\bprice\b[^\d]{0,10}([\d][\d\s.,]{2,})/i,
    /\bpris\b[^\d]{0,10}([\d][\d\s.,]{2,})/i,
  ];
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (m) {
      // Numeric group varies; try both possible captures.
      const cand = m[1] && /[\d]/.test(m[1]) ? m[1] : m[2];
      const price = toNumber(cand);
      if (price != null && price > 100) {
        out.price = price;
        // Currency guess
        const window = m[0].toLowerCase();
        for (const [hint, code] of Object.entries(CURRENCY_HINTS)) {
          if (window.includes(hint)) { out.currency = code; break; }
        }
        break;
      }
    }
  }

  // Ad-updated date
  const dateLabel =
    /(?:last\s*updated|updated|sist\s*oppdatert|last\s*modified|posted|listed)\s*[:\-]?\s*([A-Za-z0-9,\.\/\-\s]{6,25})/i;
  const md = bodyText.match(dateLabel);
  if (md) {
    const d = new Date(md[1]);
    if (!isNaN(d.getTime())) out.adLastUpdated = d.toISOString();
  }

  return out;
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/[^\d.,\-]/g, "").trim();
  if (!s) return null;
  // Handle European format: 1.234.567,00  → 1234567
  // and US: 1,234,567.00 → 1234567
  let normalized = s;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Whichever comes last is decimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // If exactly two digits after last comma → decimal
    const parts = s.split(",");
    if (parts[parts.length - 1].length === 2) normalized = s.replace(/,(?=\d{2}$)/, ".").replace(/,/g, "");
    else normalized = s.replace(/,/g, "");
  } else if (!hasComma && hasDot) {
    // If exactly two digits after last dot → decimal
    const parts = s.split(".");
    if (parts[parts.length - 1].length === 2) normalized = s.replace(/\.(?=\d{2}$)/, "D").replace(/\./g, "").replace("D", ".");
    else normalized = s.replace(/\./g, "");
  }
  const n = parseFloat(normalized);
  if (!isFinite(n)) return null;
  return Math.round(n);
}

/* ---------------- Extract pipeline ---------------- */
function extract(html) {
  const $ = cheerio.load(html);
  const parseSources = {};
  const acc = {};

  const layers = [
    ["jsonld", parseJsonLd($)],
    ["opengraph", parseOpenGraph($)],
    ["heuristic", parseHeuristic($, html)],
  ];

  for (const [source, data] of layers) {
    for (const key of ["title", "price", "currency", "status", "adLastUpdated", "image"]) {
      if (acc[key] == null && data[key] != null && data[key] !== "") {
        acc[key] = data[key];
        parseSources[key] = source;
      }
    }
  }
  // Default status if we found a price but no status text
  if (acc.price != null && !acc.status) {
    acc.status = "active";
    parseSources.status = "assumed";
  }
  return { data: acc, parseSources };
}

/* ---------------- Data helpers ---------------- */
function loadBoats() {
  const raw = readFileSync(BOATS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.boats || !Array.isArray(parsed.boats)) {
    throw new Error("boats.json mangler `boats`-array");
  }
  return parsed;
}
function saveBoats(data) {
  writeFileSync(BOATS_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/* ---------------- Main ---------------- */
async function main() {
  const store = loadBoats();
  const now = nowIso();
  const events = []; // for the email

  for (let i = 0; i < store.boats.length; i++) {
    const boat = store.boats[i];
    if (!boat.url) { log("Hopper over entry uten url"); continue; }

    // Ensure required fields
    if (!boat.id) boat.id = uid();
    if (!boat.addedAt) boat.addedAt = now;
    if (!boat.history) boat.history = [{ at: now, type: "added" }];
    const isNew = boat.price == null && boat.status == null;

    log("Sjekker", boat.url);
    let fetched;
    try {
      fetched = await fetchHtml(boat.url);
    } catch (err) {
      log(" -> fetch feilet:", err.message);
      boat.parseFailed = true;
      boat.lastCheckedAt = now;
      boat.lastError = err.message;
      // No email — bruker ba spesifikt om KUN pris/status-endringer
      await sleep(RATE_MS);
      continue;
    }

    // 404 => removed
    if (fetched.status === 404) {
      const changed = boat.status !== "removed";
      if (changed) {
        boat.history.push({ at: now, type: "status", from: boat.status || "unknown", to: "removed" });
        events.push({ kind: "status", boat, from: boat.status, to: "removed" });
        boat.lastChangeAt = now;
      }
      boat.status = "removed";
      boat.lastCheckedAt = now;
      boat.parseFailed = false;
      delete boat.lastError;
      await sleep(RATE_MS);
      continue;
    }

    const { data, parseSources } = extract(fetched.html);
    if (data.price == null && data.status == null && !data.title) {
      boat.parseFailed = true;
      boat.lastCheckedAt = now;
      boat.lastError = "kunne ikke lese pris/status/tittel";
      // No email
      await sleep(RATE_MS);
      continue;
    }

    boat.parseFailed = false;
    delete boat.lastError;

    // Fill in basic fields
    if (data.title) boat.title = data.title;
    if (data.currency) boat.currency = data.currency;
    if (data.adLastUpdated) boat.adLastUpdated = data.adLastUpdated;
    if (data.image) boat.image = data.image;
    boat.parseSources = parseSources;
    boat.lastCheckedAt = now;

    // Detect price change (only mail on ACTUAL change — not on first seed)
    if (data.price != null) {
      if (boat.price == null) {
        boat.price = data.price;
        // First-time seed: don't mail
      } else if (data.price !== boat.price) {
        events.push({
          kind: "price",
          boat,
          from: boat.price,
          to: data.price,
          direction: data.price < boat.price ? "down" : "up",
        });
        boat.history.push({ at: now, type: "price", from: boat.price, to: data.price });
        boat.price = data.price;
        boat.lastChangeAt = now;
      }
    }

    // Detect status change (only to sold/reserved/removed)
    if (data.status && data.status !== boat.status) {
      const prev = boat.status;
      // Only alert on transitions to sold/reserved/removed
      const alertStatuses = new Set(["sold", "reserved", "removed"]);
      if (alertStatuses.has(data.status)) {
        events.push({ kind: "status", boat, from: prev, to: data.status });
        boat.history.push({ at: now, type: "status", from: prev || "unknown", to: data.status });
        boat.lastChangeAt = now;
      }
      boat.status = data.status;
    }

    await sleep(RATE_MS);
  }

  saveBoats(store);

  if (events.length > 0) {
    await sendEmail(events);
    log("Sendte mail med", events.length, "hendelse(r)");
  } else {
    log("Ingen endringer å rapportere");
  }
}

/* ---------------- Email ---------------- */
async function sendEmail(events) {
  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  const to = process.env.MAIL_TO;
  if (!user || !pass || !to) {
    log("MAIL_* env-variabler mangler — hopper over mail");
    return;
  }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const dateStr = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "short", year: "numeric" });
  const subject = `Seilbåter — ${events.length} endring${events.length === 1 ? "" : "er"} ${dateStr}`;

  const rows = events.map(renderEvent).join("");
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f6f8fa; padding:20px;">
      <div style="max-width:640px; margin:auto; background:#fff; border:1px solid #e2e5e9; border-radius:10px; padding:20px;">
        <h2 style="margin:0 0 12px; color:#0f1720;">Seilbåter — daglig oppsummering</h2>
        <p style="color:#57606a; margin:0 0 16px;">${events.length} endring${events.length === 1 ? "" : "er"} i dag.</p>
        ${rows}
        <hr style="border:none; border-top:1px solid #eaeef2; margin:20px 0;" />
        <p style="color:#8b949e; font-size:12px; margin:0;">Sendt av Seilbåter-tracker · GitHub Actions</p>
      </div>
    </div>`;

  await transport.sendMail({
    from: user,
    to,
    subject,
    html,
    text: events.map(eventToText).join("\n\n"),
  });
}

function fmtMoney(n, cur) {
  if (n == null) return "—";
  try { return new Intl.NumberFormat("nb-NO").format(n) + " " + (cur || ""); }
  catch { return String(n); }
}

function renderEvent(ev) {
  const b = ev.boat;
  const title = b.title || b.url;
  const link = `<a href="${escapeAttr(b.url)}" style="color:#0969da; text-decoration:none;">${escapeHtml(title)}</a>`;
  let body = "";
  let label = "";
  let color = "#57606a";
  if (ev.kind === "price") {
    label = ev.direction === "down" ? "Pris ned" : "Pris opp";
    color = ev.direction === "down" ? "#1a7f37" : "#bf8700";
    body = `<div>${fmtMoney(ev.from, b.currency)} → <b>${fmtMoney(ev.to, b.currency)}</b></div>`;
  } else if (ev.kind === "status") {
    label = "Status endret";
    color = ev.to === "sold" ? "#cf222e" : "#8250df";
    body = `<div>${ev.from || "aktiv"} → <b>${ev.to}</b></div>`;
  } else if (ev.kind === "seeded") {
    label = "Ny båt registrert";
    color = "#0969da";
    body = `<div>Pris: <b>${fmtMoney(b.price, b.currency)}</b> · status: ${b.status || "?"}</div>`;
  } else if (ev.kind === "failed") {
    label = "Klarte ikke lese annonsen";
    color = "#cf222e";
    body = `<div style="color:#57606a; font-size:13px;">${escapeHtml(ev.reason || "")}</div>`;
  } else if (ev.kind === "recovered") {
    label = "Fungerer igjen";
    color = "#1a7f37";
    body = `<div style="color:#57606a; font-size:13px;">Annonsen kan leses igjen etter tidligere feil.</div>`;
  }
  return `
    <div style="border:1px solid #e2e5e9; border-radius:8px; padding:12px 14px; margin-bottom:10px;">
      <div style="font-size:11px; color:${color}; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">${label}</div>
      <div style="font-weight:600; margin-bottom:6px;">${link}</div>
      ${body}
      ${b.adLastUpdated ? `<div style="color:#8b949e; font-size:12px; margin-top:6px;">Annonse sist oppdatert: ${escapeHtml(b.adLastUpdated)}</div>` : ""}
    </div>`;
}

function eventToText(ev) {
  const b = ev.boat;
  const title = b.title || b.url;
  if (ev.kind === "price") return `${title}\n  Pris: ${fmtMoney(ev.from, b.currency)} -> ${fmtMoney(ev.to, b.currency)}\n  ${b.url}`;
  if (ev.kind === "status") return `${title}\n  Status: ${ev.from || "aktiv"} -> ${ev.to}\n  ${b.url}`;
  if (ev.kind === "seeded") return `Ny båt: ${title}\n  Pris: ${fmtMoney(b.price, b.currency)}\n  ${b.url}`;
  if (ev.kind === "failed") return `Feil: ${title}\n  ${ev.reason || ""}\n  ${b.url}`;
  if (ev.kind === "recovered") return `Fungerer igjen: ${title}\n  ${b.url}`;
  return `${title}\n  ${b.url}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
