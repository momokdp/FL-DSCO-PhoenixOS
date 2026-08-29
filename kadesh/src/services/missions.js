import { db, audit, nowSql } from '../db/index.js';
import { broadcast } from './events.js';

/**
 * Régénère les missions automatiques à partir des seuils min_stock.
 * Une mission auto disparaît d'elle-même quand le stock repasse au-dessus
 * du seuil ; les missions créées à la main ne sont jamais touchées.
 */
export const refreshAutoMissions = db.transaction(() => {
  const deficits = db.prepare(`
    SELECT v.station_id, v.item_id, v.min_stock - v.effective_qty AS deficit
    FROM v_effective_stock v
    JOIN stations st ON st.id = v.station_id AND st.active = 1
    WHERE v.min_stock > 0 AND v.effective_qty < v.min_stock
  `).all();

  const wanted = new Set(deficits.map(d => `${d.station_id}:${d.item_id}`));

  // Fermer les missions auto dont le besoin est comblé, sauf si un pilote est en route.
  const autos = db.prepare(`
    SELECT m.id, m.station_id, m.item_id,
           (SELECT COUNT(*) FROM mission_claims c
             WHERE c.mission_id = m.id AND c.status = 'in_progress') AS active_claims
    FROM missions m WHERE m.auto = 1 AND m.status = 'open'
  `).all();

  const close = db.prepare(`UPDATE missions SET status='fulfilled', closed_at=datetime('now') WHERE id = ?`);
  for (const m of autos) {
    if (!wanted.has(`${m.station_id}:${m.item_id}`) && m.active_claims === 0) close.run(m.id);
  }

  const upsert = db.prepare(`
    INSERT INTO missions (station_id, item_id, direction, target_qty, priority, status, auto)
    VALUES (@station_id, @item_id, 'import', @target_qty, @priority, 'open', 1)
    ON CONFLICT(station_id, item_id, direction) WHERE status = 'open'
      DO UPDATE SET target_qty = excluded.target_qty, priority = excluded.priority
  `);

  let created = 0;
  for (const d of deficits) {
    const manual = db.prepare(`
      SELECT 1 FROM missions
      WHERE station_id = ? AND item_id = ? AND direction = 'import' AND status = 'open' AND auto = 0
    `).get(d.station_id, d.item_id);
    if (manual) continue;

    upsert.run({
      station_id: d.station_id,
      item_id: d.item_id,
      target_qty: Math.max(1, Math.round(d.deficit)),
      priority: d.deficit >= 500 ? 'critical' : d.deficit >= 150 ? 'high' : 'normal',
    });
    created++;
  }
  return created;
});

/** Missions ouvertes, avec les pilotes déjà engagés dessus. */
export function listOpenMissions({ stationId = null, direction = null, userId = null } = {}) {
  const rows = db.prepare(`
    SELECT
      m.id, m.direction, m.target_qty, m.priority, m.origin, m.auto, m.created_at,
      st.id AS station_id, st.name AS station_name, st.code AS station_code,
      i.id AS item_id, i.name AS item_name, i.vendor_hint,
      COALESCE(v.effective_qty, 0) AS current_qty,
      COALESCE(v.min_stock, 0) AS min_stock,
      COALESCE(v.max_stock, 0) AS max_stock,
      (SELECT COALESCE(SUM(c.pledged_qty), 0) FROM mission_claims c
        WHERE c.mission_id = m.id AND c.status = 'in_progress') AS pledged_qty,
      (SELECT COUNT(*) FROM mission_claims c
        WHERE c.mission_id = m.id AND c.status = 'in_progress') AS claim_count,
      (SELECT c.id FROM mission_claims c
        WHERE c.mission_id = m.id AND c.status = 'in_progress' AND c.user_id = ?) AS my_claim_id
    FROM missions m
    JOIN stations st ON st.id = m.station_id
    JOIN items    i  ON i.id  = m.item_id
    LEFT JOIN v_effective_stock v ON v.station_id = m.station_id AND v.item_id = m.item_id
    WHERE m.status = 'open'
      AND (? IS NULL OR m.station_id = ?)
      AND (? IS NULL OR m.direction = ?)
    ORDER BY
      CASE m.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      st.sort_order, i.name
  `).all(userId, stationId, stationId, direction, direction);

  const claimants = db.prepare(`
    SELECT c.mission_id, u.display_name, u.callsign, u.avatar, c.pledged_qty
    FROM mission_claims c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'in_progress'
  `).all();

  const byMission = new Map();
  for (const c of claimants) {
    if (!byMission.has(c.mission_id)) byMission.set(c.mission_id, []);
    byMission.get(c.mission_id).push({
      name: c.callsign || c.display_name,
      avatar: c.avatar,
      pledged: c.pledged_qty,
    });
  }

  return rows.map(r => ({ ...r, claimants: byMission.get(r.id) || [] }));
}

/** Un pilote s'engage sur une mission. Plusieurs pilotes peuvent coexister. */
export function claimMission(missionId, userId, pledgedQty = 0) {
  const mission = db.prepare(`SELECT * FROM missions WHERE id = ? AND status = 'open'`).get(missionId);
  if (!mission) return { ok: false, error: "Cette mission n'est plus ouverte." };

  const existing = db.prepare(`
    SELECT id FROM mission_claims WHERE mission_id = ? AND user_id = ? AND status = 'in_progress'
  `).get(missionId, userId);
  if (existing) return { ok: false, error: 'Vous êtes déjà engagé sur cette mission.' };

  const info = db.prepare(`
    INSERT INTO mission_claims (mission_id, user_id, pledged_qty) VALUES (?, ?, ?)
  `).run(missionId, userId, Math.max(0, Number(pledgedQty) || 0));

  audit(userId, 'mission.claimed', 'missions', missionId, { pledged: pledgedQty });
  broadcast('missions:changed', { missionId });
  return { ok: true, claimId: info.lastInsertRowid };
}

/**
 * Le pilote déclare sa livraison. C'est ici que naît le mouvement de stock :
 * un import ajoute, un export retire.
 */
export const deliverClaim = db.transaction((claimId, userId, quantity, note = null) => {
  const claim = db.prepare(`
    SELECT c.*, m.station_id, m.item_id, m.direction, m.target_qty, m.auto
    FROM mission_claims c JOIN missions m ON m.id = c.mission_id
    WHERE c.id = ? AND c.status = 'in_progress'
  `).get(claimId);

  if (!claim) return { ok: false, error: "Cet engagement n'est plus actif." };
  if (claim.user_id !== userId) return { ok: false, error: "Cet engagement appartient à un autre pilote." };

  const qty = Math.max(0, Math.round(Number(quantity) || 0));
  if (qty <= 0) return { ok: false, error: 'Indiquez la quantité réellement livrée.' };

  const delta = claim.direction === 'import' ? qty : -qty;

  db.prepare(`
    INSERT INTO stock_adjustments (station_id, item_id, delta, source, claim_id, user_id, note, created_at)
    VALUES (?, ?, ?, 'mission', ?, ?, ?, ?)
  `).run(claim.station_id, claim.item_id, delta, claimId, userId, note, nowSql());

  db.prepare(`
    UPDATE mission_claims SET status='delivered', delivered_qty=?, closed_at=datetime('now') WHERE id = ?
  `).run(qty, claimId);

  // La mission se ferme si le besoin est couvert et que personne d'autre n'est en route.
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM mission_claims WHERE mission_id = ? AND status = 'in_progress'
  `).get(claim.mission_id).n;

  const stock = db.prepare(`
    SELECT effective_qty, min_stock FROM v_effective_stock WHERE station_id = ? AND item_id = ?
  `).get(claim.station_id, claim.item_id);

  const covered = stock && stock.min_stock > 0 ? stock.effective_qty >= stock.min_stock : true;
  if (remaining === 0 && covered) {
    db.prepare(`UPDATE missions SET status='fulfilled', closed_at=datetime('now') WHERE id = ?`)
      .run(claim.mission_id);
  }

  audit(userId, 'mission.delivered', 'missions', claim.mission_id, { qty, delta });
  broadcast('missions:changed', { missionId: claim.mission_id });
  broadcast('stock:updated', { stationId: claim.station_id });
  return { ok: true, delivered: qty };
});

/** Le pilote se désengage sans livrer. Aucun mouvement de stock. */
export function abandonClaim(claimId, userId) {
  const claim = db.prepare(`SELECT * FROM mission_claims WHERE id = ? AND status = 'in_progress'`).get(claimId);
  if (!claim) return { ok: false, error: "Cet engagement n'est plus actif." };
  if (claim.user_id !== userId) return { ok: false, error: "Cet engagement appartient à un autre pilote." };

  db.prepare(`UPDATE mission_claims SET status='abandoned', closed_at=datetime('now') WHERE id = ?`).run(claimId);
  audit(userId, 'mission.abandoned', 'missions', claim.mission_id);
  broadcast('missions:changed', { missionId: claim.mission_id });
  return { ok: true };
}

/** Engagements en cours d'un pilote. */
export function myClaims(userId) {
  return db.prepare(`
    SELECT c.id AS claim_id, c.pledged_qty, c.claimed_at,
           m.id AS mission_id, m.direction, m.target_qty, m.origin,
           st.name AS station_name, st.code AS station_code,
           i.name AS item_name, i.vendor_hint
    FROM mission_claims c
    JOIN missions m ON m.id = c.mission_id
    JOIN stations st ON st.id = m.station_id
    JOIN items i ON i.id = m.item_id
    WHERE c.user_id = ? AND c.status = 'in_progress'
    ORDER BY c.claimed_at
  `).all(userId);
}

/** Classement des pilotes sur une fenêtre glissante. */
export function leaderboard(days = 30) {
  return db.prepare(`
    SELECT u.id, u.display_name, u.callsign, u.avatar,
           COUNT(*) AS runs,
           SUM(ABS(a.delta)) AS units
    FROM stock_adjustments a
    JOIN users u ON u.id = a.user_id
    WHERE a.source = 'mission' AND a.created_at >= datetime('now', ?)
    GROUP BY u.id
    ORDER BY units DESC
    LIMIT 20
  `).all(`-${Math.max(1, days)} days`);
}
