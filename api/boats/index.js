import { listBoats, insertBoat } from "../../lib/db.js";

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

      // Bare lagre — lokal scraper henter detaljer innen 15 min
      const inserted = await insertBoat(url);
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
