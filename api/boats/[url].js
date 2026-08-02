import { deleteBoat, listBoats } from "../../lib/db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "DELETE") {
      res.setHeader("Allow", "DELETE");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const url = decodeURIComponent(req.query.url || "");
    if (!url) return res.status(400).json({ error: "URL mangler" });

    const removed = await deleteBoat(url);
    const boats = await listBoats();
    return res.status(200).json({ removed, boats });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
