// Frontend for Seilbåter — marketplace-stil.

const REPO_OWNER = "mikeljungbergtvedt";
const REPO_NAME = "seilbater";
const FILE_PATH = "boats.json";
const $ = (s) => document.querySelector(s);

let boats = [];

/* ---------- PAT ---------- */
function getPat() { return localStorage.getItem("gh_pat"); }
function setPat(v) { localStorage.setItem("gh_pat", v); }
function requirePat() {
  if (getPat()) return true;
  openModal();
  return false;
}
function openModal() {
  $("#patModal").classList.add("open");
  setTimeout(() => $("#patInput").focus(), 50);
}
function closeModal() {
  $("#patModal").classList.remove("open");
  $("#patInput").value = "";
}
$("#patCancel").addEventListener("click", closeModal);
$("#patSave").addEventListener("click", () => {
  const v = $("#patInput").value.trim();
  if (!v.startsWith("github_pat_") && !v.startsWith("ghp_")) {
    alert("Ugyldig token — skal starte med github_pat_ eller ghp_");
    return;
  }
  setPat(v);
  closeModal();
});
$("#patModal").addEventListener("click", (e) => {
  if (e.target === $("#patModal")) closeModal();
});

/* ---------- Add ---------- */
$("#addBtn").addEventListener("click", addBoat);
$("#newUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addBoat(); });

async function deleteBoat(url) {
  console.log("[delete] click, url =", JSON.stringify(url));
  console.log("[delete] boats i in-memory-lista (URLer):", boats.map(b => b.url));
  const matchingIdx = boats.findIndex(b => (b.url || "").trim() === (url || "").trim());
  console.log("[delete] match-index i in-memory:", matchingIdx);

  if (!confirm("Slette denne båten?")) return;
  if (!requirePat()) return;

  // Optimistisk oppdatering (bare hvis vi FANT båten in-memory — ellers venter vi på server-svar)
  const backupBoats = boats.slice();
  if (matchingIdx >= 0) {
    boats = boats.filter((_, i) => i !== matchingIdx);
    render();
  }
  showStatus("Sletter…", false);

  try {
    const current = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`);
    if (current.status !== 200) throw new Error(`Kunne ikke lese boats.json (${current.status})`);
    const meta = current.data;
    const currentContent = JSON.parse(atob(meta.content.replace(/\n/g, "")));
    const serverUrls = (currentContent.boats || []).map(b => b.url);
    console.log("[delete] boats på serveren (URLer):", serverUrls);
    const before = currentContent.boats.length;
    currentContent.boats = (currentContent.boats || []).filter(b => (b.url || "").trim() !== (url || "").trim());
    console.log("[delete] serverliste etter filter: før =", before, "etter =", currentContent.boats.length);

    if (currentContent.boats.length === before) {
      // Fant ikke på server — enten allerede slettet, eller URL matcher ikke eksakt.
      // Behold optimistisk UI-fjerning, ikke rull tilbake.
      showStatus("URL fantes ikke på serveren — fjernet lokalt uansett.", false);
      return;
    }

    const encoded = base64Encode(JSON.stringify(currentContent, null, 2) + "\n");
    const put = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, {
      method: "PUT",
      body: { message: `Remove boat: ${url}`, content: encoded, sha: meta.sha, branch: "main" },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`Commit feilet (${put.status}): ${put.data?.message || "ukjent"}`);
    }
    showStatus("Slettet.", false);
  } catch (err) {
    console.error("[delete] feil:", err);
    boats = backupBoats;
    render();
    showStatus("Feil ved sletting — rullet tilbake: " + err.message, true);
  }
}

async function addBoat() {
  const url = $("#newUrl").value.trim();
  if (!url) return;
  try { new URL(url); } catch { showStatus("Ikke en gyldig URL.", true); return; }
  if (!requirePat()) return;

  // Duplikat-sjekk i in-memory først
  if (boats.some(b => (b.url || "").trim() === url)) {
    showStatus("Denne URL-en er allerede lagt til.", true);
    return;
  }

  // Optimistisk placeholder — vis kortet UMIDDELBART så brukeren ser at
  // båten er lagt til (ikke må vente på commit + workflow).
  const now = new Date().toISOString();
  const placeholder = { url, addedAt: now, history: [{ at: now, type: "added" }], _pending: true };
  const backupBoats = boats.slice();
  boats = [placeholder, ...boats];
  $("#newUrl").value = "";
  render();
  showStatus("Lagt til. Henter detaljer (~1–2 min)…", false);
  $("#addBtn").disabled = true;

  try {
    const current = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`);
    if (current.status !== 200) throw new Error(`Kunne ikke lese boats.json (${current.status})`);
    const meta = current.data;
    const currentContent = JSON.parse(atob(meta.content.replace(/\n/g, "")));
    if (!currentContent.boats) currentContent.boats = [];
    if (currentContent.boats.some(b => (b.url || "").trim() === url)) {
      // Allerede på serveren (race condition) — greit, la placeholder stå
      return;
    }
    currentContent.boats.push({ url });
    const encoded = base64Encode(JSON.stringify(currentContent, null, 2) + "\n");
    const put = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, {
      method: "PUT",
      body: { message: `Add boat: ${url}`, content: encoded, sha: meta.sha, branch: "main" },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`Commit feilet (${put.status}): ${put.data?.message || "ukjent"}`);
    }
    // Planlegg re-fetch etter workflow har rukket å berike (~90 sek)
    setTimeout(() => { loadBoats(); }, 90000);
  } catch (err) {
    // Rollback UI
    boats = backupBoats;
    render();
    showStatus("Feil ved lagring — rullet tilbake: " + err.message, true);
  } finally {
    $("#addBtn").disabled = false;
  }
}

function showStatus(msg, isError) {
  const el = $("#addStatus");
  el.textContent = msg;
  el.className = "add-status" + (isError ? " error" : "");
  el.hidden = false;
  if (!isError) setTimeout(() => { el.hidden = true; }, 8000);
}

async function ghFetch(path, opts = {}) {
  const res = await fetch("https://api.github.com" + path, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + getPat(),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

/* ---------- Load & render ---------- */
async function loadBoats() {
  $("#loading").textContent = "Laster…";
  $("#loading").style.display = "";
  // Sørg for at søkefeltet er tomt ved load — hvis nettleseren har autofilt
  // med noe fra history, blir ellers listen filtrert ned til nesten ingenting.
  $("#search").value = "";
  try {
    // Hent fra raw.githubusercontent for å slippe GitHub Pages CDN-cache
    // (Pages kan trenge 1 min å redeploy etter en commit). raw. reflekterer
    // main-branchen umiddelbart etter et API-commit.
    const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/boats.json?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    boats = data.boats || [];
    $("#loading").style.display = "none";
    render();
  } catch (err) {
    $("#loading").textContent = "Kunne ikke laste boats.json: " + err.message;
  }
}

function fmtPriceValue(n) {
  if (n == null) return "—";
  try { return new Intl.NumberFormat("nb-NO").format(n); } catch { return String(n); }
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

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

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
  const container = $("#listings");
  container.innerHTML = "";

  $("#countText").textContent = `${boats.length} båt${boats.length === 1 ? "" : "er"}`;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty">
      <div style="font-size:32px; margin-bottom:8px;">⛵</div>
      <div style="font-size:16px; color: var(--text); font-weight:600; margin-bottom:4px;">Ingen båter ennå</div>
      <div>Lim inn en annonse-URL øverst for å komme i gang.</div>
    </div>`;
    return;
  }

  for (const b of list) container.appendChild(cardEl(b));
}

function cardEl(b) {
  const el = document.createElement("div");
  el.className = "card" + (b.status === "sold" ? " sold" : "");

  const status = b.status || "ukjent";
  const statusLabel = {
    active: "Aktiv", sold: "Solgt", reserved: "Reservert",
    removed: "Fjernet", unknown: "Venter", ukjent: "Venter",
  }[status] || status;

  const priceChanged = b.prevPrice && b.prevPrice !== b.price;
  const currency = b.currency || "";

  const kicker = hostname(b.url || "");

  const meta = [];
  if (b.adLastUpdated) meta.push({ k: "Annonse oppdatert", v: fmtDate(b.adLastUpdated) });
  if (b.lastCheckedAt) meta.push({ k: "Sist sjekket", v: daysAgo(b.lastCheckedAt) });

  const history = (b.history || []).slice(-2).reverse().map(h => {
    let text = "";
    if (h.type === "added") text = "Lagt til";
    else if (h.type === "price") text = `Pris: ${fmtPriceValue(h.from)} → ${fmtPriceValue(h.to)} ${currency}`;
    else if (h.type === "status") text = `Status: ${h.from} → ${h.to}`;
    else text = h.type;
    return `<div class="h-row"><span>${esc(text)}</span><span>${daysAgo(h.at)}</span></div>`;
  }).join("");

  const imageHtml = b.image
    ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.style.display='none'; this.parentElement.insertAdjacentHTML('afterbegin','<div class=&quot;placeholder&quot;>⛵</div>');" />`
    : `<div class="placeholder">⛵</div>`;

  const statusBadgeClass = b.parseFailed ? "failed" : status;
  const statusBadgeText = b.parseFailed ? "Kunne ikke lese" : statusLabel;

  el.innerHTML = `
    <div class="card-image">
      ${imageHtml}
      <div class="status-badge ${statusBadgeClass}">${esc(statusBadgeText)}</div>
    </div>
    <div class="card-content">
      <div class="card-kicker">${esc(kicker)}</div>
      <h3 class="card-title">${esc(b.title || "(venter på første sjekk)")}</h3>
      ${meta.length ? `<div class="card-meta">${meta.map(m => `<div><span class="meta-label">${m.k}:</span> ${esc(m.v)}</div>`).join("")}</div>` : ""}
      ${history ? `<div class="card-history">${history}</div>` : ""}
      ${b.lastError ? `<div class="card-error">${esc(b.lastError)}</div>` : ""}
      <div class="card-url">${esc(b.url || "")}</div>
    </div>
    <div class="card-price">
      <div class="price-value${priceChanged ? " changed" : ""}">${fmtPriceValue(b.price)} <span class="price-currency">${esc(currency)}</span></div>
      ${priceChanged ? `<div class="price-old">Var: ${fmtPriceValue(b.prevPrice)} ${esc(currency)}</div>` : ""}
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
  const delBtn = el.querySelector(".btn-delete");
  if (delBtn) delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteBoat(b.url); });
  return el;
}

$("#search").addEventListener("input", render);
$("#statusFilter").addEventListener("change", render);
$("#sort").addEventListener("change", render);

loadBoats();
