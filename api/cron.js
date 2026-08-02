import { listBoats, updateBoatFromScrape, markBoatFailed } from "../lib/db.js";
import { scrapeUrl, closeBrowser } from "../lib/scrape.js";
import { sendChangesEmail } from "../lib/mail.js";

export default async function handler(req, res) {
  // Vercel Cron sender Authorization: Bearer $CRON_SECRET
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const boats = await listBoats();
  const events = [];
  const results = [];

  for (const boat of boats) {
    try {
      const data = await scrapeUrl(boat.url);
      const change = await updateBoatFromScrape(boat.url, data);
      results.push({ url: boat.url, ok: true });
      if (change.priceChanged) {
        events.push({
          kind: "price",
          url: boat.url,
          title: data.title || boat.title,
          from: change.priceChanged.from,
          to: change.priceChanged.to,
          currency: data.currency || boat.currency,
        });
      }
      if (change.statusChanged) {
        events.push({
          kind: "status",
          url: boat.url,
          title: data.title || boat.title,
          from: change.statusChanged.from,
          to: change.statusChanged.to,
        });
      }
    } catch (err) {
      await markBoatFailed(boat.url, err.message);
      results.push({ url: boat.url, ok: false, error: err.message });
    }
  }

  try { await closeBrowser(); } catch {}

  if (events.length) {
    try { await sendChangesEmail(events); } catch (err) { console.error("[mail]", err); }
  }

  return res.status(200).json({ checked: results.length, events: events.length, results });
}
