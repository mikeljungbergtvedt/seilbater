import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

let _initPromise = null;
export async function ensureSchema() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS boats (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        price INTEGER,
        prev_price INTEGER,
        currency TEXT,
        status TEXT DEFAULT 'unknown',
        image TEXT,
        ad_last_updated TIMESTAMPTZ,
        added_at TIMESTAMPTZ DEFAULT NOW(),
        last_checked_at TIMESTAMPTZ,
        last_change_at TIMESTAMPTZ,
        parse_failed BOOLEAN DEFAULT FALSE,
        last_error TEXT,
        history JSONB DEFAULT '[]'
      )
    `;
  })();
  return _initPromise;
}

export async function listBoats() {
  await ensureSchema();
  return sql`
    SELECT id, url, title, price, prev_price, currency, status, image,
           ad_last_updated, added_at, last_checked_at, last_change_at,
           parse_failed, last_error, history
    FROM boats
    ORDER BY COALESCE(last_change_at, added_at) DESC
  `;
}

export async function getBoat(url) {
  await ensureSchema();
  const rows = await sql`SELECT * FROM boats WHERE url = ${url}`;
  return rows[0] || null;
}

export async function insertBoat(url) {
  await ensureSchema();
  const rows = await sql`
    INSERT INTO boats (url) VALUES (${url})
    ON CONFLICT (url) DO NOTHING
    RETURNING *
  `;
  return rows[0] || null;
}

export async function updateBoatFromScrape(url, data) {
  await ensureSchema();
  // Detect price change vs stored price
  const existing = await getBoat(url);
  const now = new Date();
  const history = existing?.history || [];
  let lastChangeAt = existing?.last_change_at;
  let prevPrice = existing?.prev_price;
  let priceChanged = false;
  let statusChanged = false;

  if (data.price != null && existing?.price != null && data.price !== existing.price) {
    prevPrice = existing.price;
    lastChangeAt = now;
    priceChanged = { from: existing.price, to: data.price };
    history.push({ at: now.toISOString(), type: "price", from: existing.price, to: data.price });
  }

  const alertStatuses = new Set(["sold", "reserved", "removed"]);
  if (data.status && existing?.status && data.status !== existing.status && alertStatuses.has(data.status)) {
    statusChanged = { from: existing.status, to: data.status };
    lastChangeAt = now;
    history.push({ at: now.toISOString(), type: "status", from: existing.status, to: data.status });
  }

  await sql`
    UPDATE boats SET
      title = COALESCE(${data.title || null}, title),
      price = COALESCE(${data.price ?? null}, price),
      prev_price = ${prevPrice ?? null},
      currency = COALESCE(${data.currency || null}, currency),
      status = COALESCE(${data.status || null}, status),
      image = COALESCE(${data.image || null}, image),
      ad_last_updated = COALESCE(${data.adLastUpdated || null}, ad_last_updated),
      last_checked_at = ${now.toISOString()},
      last_change_at = ${lastChangeAt ? new Date(lastChangeAt).toISOString() : null},
      parse_failed = FALSE,
      last_error = NULL,
      history = ${JSON.stringify(history)}::jsonb
    WHERE url = ${url}
  `;

  return { priceChanged, statusChanged };
}

export async function markBoatFailed(url, error) {
  await ensureSchema();
  await sql`
    UPDATE boats SET
      parse_failed = TRUE,
      last_error = ${error},
      last_checked_at = NOW()
    WHERE url = ${url}
  `;
}

export async function deleteBoat(url) {
  await ensureSchema();
  const rows = await sql`DELETE FROM boats WHERE url = ${url} RETURNING id`;
  return rows.length > 0;
}
