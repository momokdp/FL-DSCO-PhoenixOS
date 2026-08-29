import { db, getSetting } from '../db/index.js';

/** Stations avec leur état vital et le nombre de marchandises sous seuil. */
export function listStations({ includeInactive = false } = {}) {
  return db.prepare(`
    SELECT
      st.id, st.name, st.code, st.api_name, st.system, st.active, st.sort_order,
      ss.money, ss.health, ss.cargospace, ss.cargo_used, ss.synced_at,
      (SELECT COUNT(*) FROM v_effective_stock v
        WHERE v.station_id = st.id AND v.min_stock > 0 AND v.effective_qty < v.min_stock) AS shortages,
      (SELECT COUNT(*) FROM stock_snapshots s WHERE s.station_id = st.id) AS item_count
    FROM stations st
    LEFT JOIN station_status ss ON ss.station_id = st.id
    ${includeInactive ? '' : 'WHERE st.active = 1'}
    ORDER BY st.sort_order, st.name
  `).all();
}

/** Inventaire complet d'une station. */
export function stationInventory(stationId) {
  return db.prepare(`
    SELECT
      i.id AS item_id, i.name, i.category, i.vendor_hint,
      v.confirmed_qty, v.pending_qty, v.effective_qty,
      v.min_stock, v.max_stock, v.synced_at,
      CASE
        WHEN v.min_stock > 0 AND v.effective_qty <= 0                THEN 'empty'
        WHEN v.min_stock > 0 AND v.effective_qty < v.min_stock       THEN 'low'
        WHEN v.max_stock > 0 AND v.effective_qty >= v.max_stock      THEN 'full'
        ELSE 'ok'
      END AS level
    FROM v_effective_stock v
    JOIN items i ON i.id = v.item_id
    WHERE v.station_id = ?
    ORDER BY
      CASE WHEN v.min_stock > 0 AND v.effective_qty < v.min_stock THEN 0 ELSE 1 END,
      i.name
  `).all(stationId);
}

/** Stock effectif d'une marchandise sur toutes les stations. */
export function itemAcrossStations(itemId) {
  return db.prepare(`
    SELECT st.id AS station_id, st.name, st.code,
           COALESCE(v.effective_qty, 0) AS qty,
           COALESCE(v.min_stock, 0) AS min_stock
    FROM stations st
    LEFT JOIN v_effective_stock v ON v.station_id = st.id AND v.item_id = ?
    WHERE st.active = 1
    ORDER BY st.sort_order, st.name
  `).all(itemId);
}

export function syncState() {
  const last = db.prepare(`
    SELECT started_at, finished_at, status, stations_seen, rows_written, message
    FROM sync_log ORDER BY id DESC LIMIT 1
  `).get();
  return { last: last || null, lastSyncAt: getSetting('last_sync_at') };
}
