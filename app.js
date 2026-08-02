// Frontend for Seilbåter — leser boats.json, lar bruker legge til båter via GitHub API.

const REPO_OWNER = "mikeljungbergtvedt";
const REPO_NAME = "seilbater";
const FILE_PATH = "boats.json";

const $ = (s) => document.querySelector(s);
let boats = [];

/* ---------- PAT-håndtering ---------- */
function getPat() { return localStorage.getItem("gh_pat"); }
function setPat(v) { localStorage.setItem("gh_pat", v); }
function requirePat() {
  if (getPat()) return true;
  $("#patModal").classList.add("open");
  setTimeout(() => $("#patInput").focus(), 50);
  return false;
}

$("#patSave").addEventListener("click", () => {
  const v = $("#patInput").value.trim();
  if (!v.startsWith("github_pat_") && !v.startsWith("ghp_")) {
    alert("Det ser ikke ut som et gyldig GitHub token (skal starte med github_pat_ eller ghp_).");
    return;
  }
  setPat(v);
  $("#patModal").classList.remove("open");
  $("#patInput").value = "";
});

/* ---------- Legg til båt ---------- */
$("#addBtn").addEventListener("click", async () => {
  const url = $("#newUrl").value.trim();
  if (!url) return;
  try { new URL(url); } catch { setStatus("Ikke en gyldig URL.", true); return; }
  if (!requirePat()) return;

  setStatus("Legger til…", false);
  $("#addBtn").disabled = true;

  try {
    // Hent nåværende boats.json med sha
    const current = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`);
    if (current.status !== 200) throw new Error(`Kunne ikke lese boats.json (${current.status})`);
    const meta = current.data;
    const currentContent = JSON.parse(atob(meta.content.replace(/\n/g, "")));
    if (!currentContent.boats) currentContent.boats = [];

    // Sjekk duplikat
    if (currentContent.boats.some(b => (b.url || "").trim() === url)) {
      setStatus("Denne URL-en er allerede lagt til.", true);
      return;
    }

    currentContent.boats.push({ url });
    const newContent = JSON.stringify(currentContent, null, 2) + "\n";
    const encoded = base64Encode(newContent);

    const put = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, {
      method: "PUT",
      body: {
        message: `Add boat: ${url}`,
        content: encoded,
        sha: meta.sha,
        branch: "main",
      },
    });
    if (put.status !== 200 && put.status !== 201) {
      throw new Error(`Kunne ikke commite (${put.status}): ${put.data?.message || "ukjent feil"}`);
    }

    $("#newUrl").value = "";
    setStatus("Lagt til. Trigg workflow manuelt hvis du vil ha den beriket nå — ellers skjer det ved neste 07:00-kjøring.", false);
    await loadBoats();
  } catch (err) {
    setStatus("Feil: " + err.message, true);
  } finally {
    $("#addBtn").disabled = false;
  }
});

$("#newUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#addBtn").click();
});

function setStatus(msg, isError) {
  const el = $("#addStatus");
  el.textContent = msg;
  el.className = "add-status" + (isError ? " error" : " ok");
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
  // UTF-8-safe base64
  return btoa(unescape(encodeURIComponent(str)));
}

/* ---------- Vis lista ---------- */
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
