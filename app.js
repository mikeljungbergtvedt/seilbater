// Frontend for Seilbåter — leser boats.json og viser båtene sortert/filtrert.

const $ = (s) => document.querySelector(s);
let boats = [];

async function loadBoats() {
  $("#loading").textContent = "Laster…";
  $("#loading").style.display = "";
  try {
    const res = await fetch("boats.json?" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    boats = data.boats || [];
    $("#loading").style.display = "none";
    render();
  } catch (err) {
    $("#loading").textContent = "Klarte ikke laste boats.json: " + err.message;
  }
}

function fmtPrice(n, cur) {
  if (n == null) return "—";
  try { return new Intl.NumberFormat("nb-NO").format(n) + " " + (cur || ""); }
  catch { return String(n); }
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("nb-NO", { day: "2-digit", month: "short", year: "numeric" });
}
function daysAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff <= 0) return "i dag";
  if (diff === 1) return "i går";
  return diff + " dager siden";
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function filtered() {
  const q = $("#search").value.trim().toLowerCase();
  const s = $("#statusFilter").value;
  let list = boats.slice();
  if (q) list = list.filter(b => (b.title || "").toLowerCase().includes(q) || (b.url || "").toLowerCase().includes(q));
  if (s !== "all") list = list.filter(b => (b.status || "unknown") === s);

  const sort = $("#sort").value;
  list.sort((a, b) => {
    switch (sort) {
      case "addedAt-desc": return cmp(b.addedAt, a.addedAt);
      case "addedAt-asc":  return cmp(a.addedAt, b.addedAt);
      case "price-asc":    return cmp(a.price ?? Infinity, b.price ?? Infinity);
      case "price-desc":   return cmp(b.price ?? -Infinity, a.price ?? -Infinity);
      case "title-asc":    return (a.title || "").localeCompare(b.title || "", "nb");
      default:             return cmp(b.lastChangeAt || b.addedAt, a.lastChangeAt || a.addedAt);
    }
  });
  return list;
}
function cmp(a, b) { if (a === b) return 0; if (a == null) return 1; if (b == null) return -1; return a < b ? -1 : 1; }

function render() {
  const list = filtered();
  const grid = $("#grid");
  grid.innerHTML = "";

  const stats = [];
  stats.push(`<span><b>${boats.length}</b> båter</span>`);
  stats.push(`<span><b>${boats.filter(b => b.status === "active").length}</b> aktive</span>`);
  stats.push(`<span><b>${boats.filter(b => b.status === "sold").length}</b> solgte</span>`);
  const failing = boats.filter(b => b.parseFailed).length;
  if (failing) stats.push(`<span style="color:#ffb454"><b>${failing}</b> feilet ved henting</span>`);
  $("#stats").innerHTML = stats.join("");

  if (list.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">Ingen båter matcher filtrene.</div>`;
    return;
  }

  for (const b of list) grid.appendChild(cardEl(b));
}

function cardEl(b) {
  const el = document.createElement("div");
  el.className = "card" + (b.status === "sold" ? " sold" : "");
  const status = b.status || "ukjent";

  const badges = [];
  badges.push(`<span class="badge ${status}">${status}</span>`);
  if (b.parseFailed) badges.push(`<span class="badge failed">feilet</span>`);

  const history = (b.history || []).slice(-3).reverse().map(h => {
    let text = "";
    if (h.type === "added") text = "Lagt til";
    else if (h.type === "price") text = `Pris: ${fmtPrice(h.from, b.currency)} → ${fmtPrice(h.to, b.currency)}`;
    else if (h.type === "status") text = `Status: ${h.from} → ${h.to}`;
    else text = h.type;
    return `<div class="row"><span>${esc(text)}</span><span>${daysAgo(h.at)}</span></div>`;
  }).join("");

  el.innerHTML = `
    <div class="badges">${badges.join("")}</div>
    <div class="title">${esc(b.title || "(ingen tittel — venter på første sjekk)")}</div>
    <div class="price">${fmtPrice(b.price, b.currency)}</div>
    <div class="meta">
      ${b.adLastUpdated ? `<span>Annonse oppdatert: ${esc(fmtDate(b.adLastUpdated))}</span>` : ""}
      ${b.lastChangeAt ? `<span>Sist endring hos oss: ${daysAgo(b.lastChangeAt)}</span>` : ""}
      ${b.lastCheckedAt ? `<span>Sist sjekket: ${daysAgo(b.lastCheckedAt)}</span>` : ""}
    </div>
    <a class="link" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.url)}</a>
    ${history ? `<div class="history">${history}</div>` : ""}
    ${b.lastError ? `<div class="meta" style="color:#ffb454;">Feil: ${esc(b.lastError)}</div>` : ""}
  `;
  return el;
}

$("#search").addEventListener("input", render);
$("#statusFilter").addEventListener("change", render);
$("#sort").addEventListener("change", render);
$("#reload").addEventListener("click", loadBoats);

loadBoats();
