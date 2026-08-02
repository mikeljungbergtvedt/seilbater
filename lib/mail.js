import nodemailer from "nodemailer";

export async function sendChangesEmail(events) {
  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  const to = process.env.MAIL_TO;
  if (!user || !pass || !to) {
    console.warn("[mail] MAIL_* env-variabler mangler — hopper over mail");
    return;
  }
  if (!events.length) return;

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const dateStr = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "short", year: "numeric" });
  const subject = `Seilbåter — ${events.length} endring${events.length === 1 ? "" : "er"} ${dateStr}`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f6f8fa; padding:20px;">
      <div style="max-width:640px; margin:auto; background:#fff; border:1px solid #e2e5e9; border-radius:10px; padding:20px;">
        <h2 style="margin:0 0 12px; color:#0f1720;">Seilbåter — endringer</h2>
        <p style="color:#57606a; margin:0 0 16px;">${events.length} endring${events.length === 1 ? "" : "er"} siden sist.</p>
        ${events.map(renderEvent).join("")}
      </div>
    </div>`;

  await transport.sendMail({
    from: user,
    to,
    subject,
    html,
    text: events.map(e => `${e.title || e.url}\n${describeEvent(e)}\n${e.url}`).join("\n\n"),
  });
}

function renderEvent(ev) {
  const link = `<a href="${escAttr(ev.url)}" style="color:#0969da;">${escHtml(ev.title || ev.url)}</a>`;
  let label = "", body = "", color = "#57606a";
  if (ev.kind === "price") {
    const dir = ev.to < ev.from ? "ned" : "opp";
    label = `Pris ${dir}`;
    color = dir === "ned" ? "#1a7f37" : "#bf8700";
    body = `<div>${fmt(ev.from, ev.currency)} → <b>${fmt(ev.to, ev.currency)}</b></div>`;
  } else if (ev.kind === "status") {
    label = "Status endret";
    color = ev.to === "sold" ? "#cf222e" : "#8250df";
    body = `<div>${ev.from || "?"} → <b>${ev.to}</b></div>`;
  }
  return `
    <div style="border:1px solid #e2e5e9; border-radius:8px; padding:12px; margin-bottom:10px;">
      <div style="font-size:11px; color:${color}; text-transform:uppercase; margin-bottom:4px;">${label}</div>
      <div style="font-weight:600; margin-bottom:6px;">${link}</div>
      ${body}
    </div>`;
}
function describeEvent(ev) {
  if (ev.kind === "price") return `Pris: ${fmt(ev.from, ev.currency)} -> ${fmt(ev.to, ev.currency)}`;
  if (ev.kind === "status") return `Status: ${ev.from} -> ${ev.to}`;
  return "";
}
function fmt(n, cur) {
  if (n == null) return "—";
  try { return new Intl.NumberFormat("nb-NO").format(n) + " " + (cur || ""); } catch { return String(n); }
}
function escHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escAttr(s) { return escHtml(s); }
