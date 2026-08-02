import { listBoats, insertBoat, updateBoatFromScrape, markBoatFailed } from "../../lib/db.js";
import { scrapeUrl, closeBrowser } from "../../lib/scrape.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const boats = await listBoats();
      return res.status(200).json({ boats });
    }

    if (req.method === "POST") {
      const { url } = req.body || {};
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "url må sendes med" });
      }
      try { new URL(url); } catch { return res.status(400).json({ error: "ikke en gyldig URL" }); }

      // Insert (or return existing)
      const inserted = await insertBoat(url);
      // Scrape immediately — men hopp over stille for domener som
      // vi vet at lokal scraper håndterer (yachtworld osv).
      try {
        const data = await scrapeUrl(url);
        await updateBoatFromScrape(url, data);
      } catch (err) {
        if (err.message === "PENDING_LOCAL") {
          // Bevisst hoppet over — lokal scraper henter innen 15 min.
          // Ikke marker som failed; la parseFailed være false.
          console.log("[scrape]", url, "— pending local scraper");
        } else {
          console.error("[scrape]", url, err.message);
          await markBoatFailed(url, err.message);
        }
      }

      const boats = await listBoats();
      return res.status(inserted ? 201 : 200).json({ boats });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
