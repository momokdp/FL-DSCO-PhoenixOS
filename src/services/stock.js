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
      v.api_min_stock, v.api_max_stock,
      v.custom_min_stock, v.custom_max_stock, v.threshold_note, v.has_custom,
      v.is_export, v.is_hidden, v.risk_bonus, v.origin, v.destination,
      CASE
        -- Marchandise produite : l'objectif est la soute vidée jusqu'au
        -- plancher. Un stock qui déborde le plafond devient alarmant.
        WHEN v.is_export = 1 AND v.max_stock > 0
             AND v.effective_qty > v.max_stock                       THEN 'low'
        WHEN v.is_export = 1 AND v.effective_qty <= v.min_stock      THEN 'full'
        WHEN v.is_export = 1                                         THEN 'ok'

        -- Marchandise consommée : l'objectif est la soute pleine.
        WHEN v.effective_qty <= 0                                    THEN 'empty'
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

/* ------------------------------------------------------- seuils réglés */

/**
 * Fixe ou lève les seuils d'une marchandise sur une station.
 *
 * Passer null sur une valeur rétablit celle de l'API pour ce seuil seul.
 * Quand les deux redeviennent nuls, la ligne est supprimée : une table de
 * réglages ne doit contenir que de vrais réglages.
 */
export function setThreshold({ stationId, itemId, minStock, maxStock, note, isExport, isHidden, riskBonus, origin, destination, userId }) {
  const propre = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const min = propre(minStock);
  const max = propre(maxStock);

  if (min !== null && (!Number.isFinite(min) || min < 0)) {
    return { ok: false, error: 'Le seuil bas doit être un nombre positif.' };
  }
  if (max !== null && (!Number.isFinite(max) || max < 0)) {
    return { ok: false, error: 'Le plafond doit être un nombre positif.' };
  }
  if (min !== null && max !== null && min > max) {
    return { ok: false, error: 'Le seuil bas ne peut pas dépasser le plafond.' };
  }

  const exporte = isExport ? 1 : 0;
  const masque = isHidden ? 1 : 0;
  // Bornée : une prime aberrante fausserait durablement le classement.
  const prime = Math.min(10, Math.max(0.1, Number(riskBonus) || 1));

  const depuis = (origin || '').trim() || null;
  const vers = (destination || '').trim() || null;

  if (min === null && max === null && !exporte && !masque && prime === 1 && !depuis && !vers) {
    db.prepare('DELETE FROM stock_thresholds WHERE station_id = ? AND item_id = ?')
      .run(stationId, itemId);
    return { ok: true, cleared: true };
  }

  db.prepare(`
    INSERT INTO stock_thresholds
      (station_id, item_id, min_stock, max_stock, note, is_export, is_hidden, risk_bonus, origin, destination, updated_by)
    VALUES
      (@station_id, @item_id, @min_stock, @max_stock, @note, @is_export, @is_hidden, @risk_bonus, @origin, @destination, @updated_by)
    ON CONFLICT(station_id, item_id) DO UPDATE SET
      min_stock  = excluded.min_stock,
      max_stock  = excluded.max_stock,
      note       = excluded.note,
      is_export  = excluded.is_export,
      is_hidden  = excluded.is_hidden,
      risk_bonus = excluded.risk_bonus,
      origin      = excluded.origin,
      destination = excluded.destination,
      updated_at = datetime('now'),
      updated_by = excluded.updated_by
  `).run({
    station_id: stationId,
    item_id: itemId,
    min_stock: min,
    max_stock: max,
    note: note || null,
    is_export: exporte,
    is_hidden: masque,
    risk_bonus: prime,
    origin: depuis,
    destination: vers,
    updated_by: userId || null,
  });

  return { ok: true };
}

/** Liste des seuils réglés à la main, tous stations confondues. */
export function listThresholds() {
  return db.prepare(`
    SELECT t.station_id, t.item_id, t.min_stock, t.max_stock, t.note,
           t.is_export, t.is_hidden, t.risk_bonus, t.updated_at,
           st.name AS station_name, st.code AS station_code,
           i.name AS item_name,
           s.min_stock AS api_min_stock, s.max_stock AS api_max_stock,
           u.callsign, u.display_name
    FROM stock_thresholds t
    JOIN stations st ON st.id = t.station_id
    JOIN items i     ON i.id  = t.item_id
    LEFT JOIN stock_snapshots s ON s.station_id = t.station_id AND s.item_id = t.item_id
    LEFT JOIN users u ON u.id = t.updated_by
    ORDER BY st.sort_order, st.name, i.name
  `).all();
}
