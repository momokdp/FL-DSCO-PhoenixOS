import { config } from '../config.js';
import { db, nowSql, setSetting } from '../db/index.js';
import { broadcast } from '../services/events.js';

let timer = null;
let running = false;

/**
 * Interroge darkstat et réécrit les relevés de stock.
 * Ne touche jamais à stock_adjustments : les livraisons des pilotes
 * deviennent simplement caduques dès que leur horodatage est antérieur
 * au nouveau synced_at.
 */
export async function syncNow({ trigger = 'auto' } = {}) {
  if (running) return { skipped: true, reason: 'Une synchronisation est déjà en cours.' };
  running = true;

  const logId = db.prepare(`INSERT INTO sync_log (status, message) VALUES ('running', ?)`)
    .run(`déclenchée : ${trigger}`).lastInsertRowid;

  try {
    // Horodaté avant l'appel : les données décrivent l'état au début de la
    // requête. Stamper après ferait passer pour « déjà intégrées » les
    // livraisons déclarées pendant que darkstat répondait.
    const stamp = nowSql();
    const pobs = await fetchPobs();
    const result = writeSnapshots(pobs, stamp);

    db.prepare(`
      UPDATE sync_log
      SET finished_at = datetime('now'), status = ?, stations_seen = ?, rows_written = ?, message = ?
      WHERE id = ?
    `).run(
      result.missing.length ? 'partial' : 'ok',
      result.stationsSeen,
      result.rowsWritten,
      result.missing.length
        ? `Stations introuvables côté API : ${result.missing.join(', ')}`
        : 'Relevé complet.',
      logId
    );

    setSetting('last_sync_at', nowSql());
    broadcast('stock:updated', { stations: result.stationsSeen, rows: result.rowsWritten });
    return { ok: true, ...result };

  } catch (err) {
    console.error('[sync] échec :', err.message);
    db.prepare(`
      UPDATE sync_log SET finished_at = datetime('now'), status = 'error', message = ? WHERE id = ?
    `).run(String(err.message).slice(0, 500), logId);
    broadcast('sync:error', { message: err.message });
    return { ok: false, error: err.message };

  } finally {
    running = false;
  }
}

async function fetchPobs() {
  const url = config.darkstat.baseUrl + config.darkstat.pobsPath;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), config.darkstat.timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'KadeshConsole/1.0' },
    });
    if (!res.ok) throw new Error(`darkstat a répondu HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Réponse inattendue : un tableau de bases était attendu.');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`darkstat n’a pas répondu en ${config.darkstat.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function writeSnapshots(pobs, stamp = nowSql()) {
  const stations = db.prepare('SELECT id, api_name FROM stations WHERE active = 1').all();
  const byApiName = new Map(pobs.map(p => [String(p.name || '').trim(), p]));

  const findItem = db.prepare('SELECT id FROM items WHERE name = ? COLLATE NOCASE');
  const insertItem = db.prepare('INSERT INTO items (name, category) VALUES (?, ?)');
  const upsertStock = db.prepare(`
    INSERT INTO stock_snapshots
      (station_id, item_id, quantity, min_stock, max_stock, price, is_selling, synced_at)
    VALUES (@station_id, @item_id, @quantity, @min_stock, @max_stock, @price, @is_selling, @synced_at)
    ON CONFLICT(station_id, item_id) DO UPDATE SET
      quantity   = excluded.quantity,
      min_stock  = excluded.min_stock,
      max_stock  = excluded.max_stock,
      price      = excluded.price,
      is_selling = excluded.is_selling,
      synced_at  = excluded.synced_at
  `);
  const upsertStatus = db.prepare(`
    INSERT INTO station_status (station_id, money, health, cargospace, cargo_used, synced_at)
    VALUES (@station_id, @money, @health, @cargospace, @cargo_used, @synced_at)
    ON CONFLICT(station_id) DO UPDATE SET
      money = excluded.money, health = excluded.health,
      cargospace = excluded.cargospace, cargo_used = excluded.cargo_used,
      synced_at = excluded.synced_at
  `);

  const missing = [];
  let stationsSeen = 0, rowsWritten = 0;

  const run = db.transaction(() => {
    for (const station of stations) {
      const pob = byApiName.get(station.api_name);
      if (!pob) { missing.push(station.api_name); continue; }
      stationsSeen++;

      const shopItems = Array.isArray(pob.shop_items) ? pob.shop_items : [];
      let used = 0;

      for (const raw of shopItems) {
        const name = String(raw.name || '').trim();
        if (!name) continue;

        let item = findItem.get(name);
        if (!item) item = { id: insertItem.run(name, 'commodity').lastInsertRowid };

        const qty = Number(raw.quantity) || 0;
        used += qty;

        upsertStock.run({
          station_id: station.id,
          item_id: item.id,
          quantity: qty,
          min_stock: Number(raw.min_stock) || 0,
          max_stock: Number(raw.max_stock) || 0,
          price: raw.price != null ? Number(raw.price) : null,
          is_selling: raw.is_selling ? 1 : 0,
          synced_at: stamp,
        });
        rowsWritten++;
      }

      upsertStatus.run({
        station_id: station.id,
        money: Number(pob.money) || 0,
        health: Number(pob.health) || 0,
        cargospace: Number(pob.cargospace) || 0,
        cargo_used: used,
        synced_at: stamp,
      });
    }
  });

  run();
  return { stationsSeen, rowsWritten, missing };
}

export function startSyncWorker() {
  if (timer) return;
  const every = config.darkstat.intervalMs;
  console.log(`[sync] worker actif — relevé toutes les ${every / 60000} min`);
  syncNow({ trigger: 'démarrage' });
  timer = setInterval(() => syncNow({ trigger: 'planifié' }), every);
}

export function stopSyncWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isSyncRunning() { return running; }
