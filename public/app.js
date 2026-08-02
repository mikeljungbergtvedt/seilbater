// Frontend for Seilbåter (Vercel-backend-versjon).
const $ = (s) => document.querySelector(s);
let boats = [];

async function loadBoats() {
  $("#loading").textContent = "Laster…";
  $("#loading").style.display = "";
  $("#search").value = "";
  try {
    const res = await fetch("/api/boats", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    boats = (data.boats || []).map(normalizeBoat);
    $("#loading").style.display = "none";
    render();
  } catch (err) {
    $("#loading").textContent = "Kunne ikke laste båter: " + err.message;
  }
}

function normalizeBoat(b) {
  // DB returnerer snake_case; UI bruker camelCase
  return {
    id: b.id,
    url: b.url,
    title: b.title,
    price: b.price,
    prevPrice: b.prev_price,
    currency: b.currency,
    status: b.status,
    image: b.image,
    adLastUpdated: b.ad_last_updated,
    addedAt: b.added_at,
    lastCheckedAt: b.last_checked_at,
    lastChangeAt: b.last_change_at,
    parseFailed: b.parse_failed,
    lastError: b.last_error,
    history: b.history || [],
  };
}

async function addBoat() {
  const url = $("#newUrl").value.trim();
  if (!url) return;
  try { new URL(url); } catch { showStatus("Ikke en gyldig URL.", true); return; }
  if (boats.some(b => b.url === url)) { showStatus("Denne URL-en er allerede lagt til.", true); return; }

  // Optimistisk placeholder
  const now = new Date().toISOString();
  const placeholder = { url, addedAt: now, history: [{ at: now, type: "added" }], _pending: true };
  const backup = boats.slice();
  boats = [placeholder, ...boats];
  $("#newUrl").value = "";
  render();
  showStatus("Henter detaljer…", false);
  $("#addBtn").disabled = true;

  try {
    const res = await fetch("/api/boats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    boats = (data.boats || []).map(normalizeBoat);
    render();
    showStatus("Lagt til. Detaljer hentes innen ~15 min.", false);
  } catch (err) {
    boats = backup; render();
    showStatus("Feil: " + err.message, true);
  } finally {
    $("#addBtn").disabled = false;
  }
}

async function deleteBoat(url) {
  if (!confirm("Slette denne båten?")) return;
  const backup = boats.slice();
  boats = boats.filter(b => b.url !== url);
  render();
  showStatus("Sletter…", false);
  try {
    const res = await fetch("/api/boats/" + encodeURIComponent(url), { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    boats = (data.boats || []).map(normalizeBoat);
    render();
    showStatus("Slettet.", false);
  } catch (err) {
    boats = backup; render();
    showStatus("Feil ved sletting: " + err.message, true);
  }
}

function showStatus(msg, isError) {
  const el = $("#addStatus");
  el.textContent = msg;
  el.className = "add-status" + (isError ? " error" : "");
  el.hidden = false;
  if (!isError) setTimeout(() => { el.hidden = true; }, 5000);
}

$("#addBtn").addEventListener("click", addBoat);
$("#newUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addBoat(); });

/* ---------- Rendering ---------- */
function fmtPrice(n) { if (n == null) return "—"; try { return new Intl.NumberFormat("nb-NO").format(n); } catch { return String(n); } }
function fmtDate(iso) { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString("nb-NO", { day:"2-digit", month:"short", year:"numeric" }); }
function daysAgo(iso) { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return ""; const diff = Math.floor((Date.now() - d.getTime())/86400000); if (diff <= 0) return "i dag"; if (diff === 1) return "i går"; return diff + " dager siden"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function hostname(url) { try { return new URL(url).hostname.replace(/^www\./,""); } catch { return url; } }

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
  const grid = $("#listings");
  grid.innerHTML = "";
  $("#countText").textContent = `${boats.length} båt${boats.length === 1 ? "" : "er"}`;
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty">
      <div style="font-size:32px;margin-bottom:8px;">⛵</div>
      <div style="font-size:16px;color:var(--text);font-weight:600;margin-bottom:4px;">Ingen båter ennå</div>
      <div>Lim inn en annonse-URL øverst for å komme i gang.</div>
    </div>`;
    return;
  }
  for (const b of list) grid.appendChild(cardEl(b));
}

function cardEl(b) {
  const el = document.createElement("div");
  el.className = "card" + (b.status === "sold" ? " sold" : "");
  const status = b.status || "ukjent";
  const statusLabel = { active:"Aktiv", sold:"Solgt", reserved:"Reservert", removed:"Fjernet", unknown:"Venter", ukjent:"Venter" }[status] || status;
  const priceChanged = b.prevPrice && b.prevPrice !== b.price;
  const currency = b.currency || "";
  const kicker = hostname(b.url || "");
  const imageHtml = b.image
    ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.insertAdjacentHTML('afterbegin','<div class=&quot;placeholder&quot;>⛵</div>');" />`
    : `<div class="placeholder">⛵</div>`;
  const badgeClass = b._pending ? "unknown" : (b.parseFailed ? "failed" : status);
  const badgeText = b._pending ? "Henter…" : (b.parseFailed ? "Kunne ikke lese" : statusLabel);

  el.innerHTML = `
    <div class="card-image">
      ${imageHtml}
      <div class="status-badge ${badgeClass}">${esc(badgeText)}</div>
    </div>
    <div class="card-content">
      <div class="card-kicker">${esc(kicker)}</div>
      <h3 class="card-title">${esc(b.title || (b._pending ? "Henter…" : "(venter på første sjekk)"))}</h3>
      <div class="card-meta">
        ${b.adLastUpdated ? `<div><span class="meta-label">Annonse oppdatert:</span> ${esc(fmtDate(b.adLastUpdated))}</div>` : ""}
        ${b.lastCheckedAt ? `<div><span class="meta-label">Sist sjekket:</span> ${daysAgo(b.lastCheckedAt)}</div>` : ""}
      </div>
      ${b.lastError ? `<div class="card-error">${esc(b.lastError)}</div>` : ""}
      <div class="card-url">${esc(b.url || "")}</div>
    </div>
    <div class="card-price">
      <div class="price-value${priceChanged ? " changed" : ""}">${fmtPrice(b.price)} <span class="price-currency">${esc(currency)}</span></div>
      ${priceChanged ? `<div class="price-old">Var: ${fmtPrice(b.prevPrice)} ${esc(currency)}</div>` : ""}
      <div class="price-detail">
        ${b.addedAt ? `<div class="row"><span class="k">Lagt til</span><span>${daysAgo(b.addedAt)}</span></div>` : ""}
        ${b.lastChangeAt ? `<div class="row"><span class="k">Sist endring</span><span>${daysAgo(b.lastChangeAt)}</span></div>` : ""}
      </div>
      <div class="cta">
        <a href="${esc(b.url)}" target="_blank" rel="noopener">Åpne annonsen</a>
        <button class="btn-delete" data-url="${esc(b.url)}">Slett</button>
      </div>
    </div>
  `;
  const del = el.querySelector(".btn-delete");
  if (del) del.addEventListener("click", (e) => { e.stopPropagation(); deleteBoat(b.url); });
  return el;
}

$("#search").addEventListener("input", render);
$("#statusFilter").addEventListener("change", render);
$("#sort").addEventListener("change", render);

loadBoats();
