import { db, audit, nowSql } from '../db/index.js';
import { broadcast } from './events.js';

/**
 * Régénère les missions automatiques à partir des seuils min_stock.
 * Une mission auto disparaît d'elle-même quand le stock repasse au-dessus
 * du seuil ; les missions créées à la main ne sont jamais touchées.
 */
/**
 * Plafond de vraisemblance.
 *
 * En jeu, un plafond à 999 999 999 sert à laisser n'importe qui vendre sans
 * butoir. Le prendre pour objectif ouvrirait une mission d'un milliard
 * d'unités. Au-delà de cette borne, on considère que le plafond n'exprime
 * aucun besoin réel et on attend qu'un officier règle la valeur dans
 * « Gestion → Seuils ».
 */
const PLAFOND_ABSURDE = 5_000_000;

export const refreshAutoMissions = db.transaction(() => {
  // Objectif visé, et non seuil d'alerte.
  //
  //  - marchandise consommée : on veut la soute PLEINE, donc on comble
  //    l'écart jusqu'au plafond. Attendre le seuil bas reviendrait à ne
  //    remplir la station que lorsqu'elle est déjà presque vide.
  //  - marchandise produite : on veut la soute VIDÉE jusqu'au seuil bas,
  //    donc on fait enlever tout ce qui dépasse ce plancher.
  //
  // Les seuils opposés gardent un rôle : ils marquent l'urgence. Passer
  // sous le seuil bas (ou au-dessus du plafond) rend la mission critique.
  const besoins = db.prepare(`
    SELECT v.station_id, v.item_id, 'import' AS direction,
           v.max_stock - v.effective_qty AS qty,
           CASE WHEN v.min_stock > 0 AND v.effective_qty < v.min_stock
                THEN 1 ELSE 0 END AS urgent
    FROM v_effective_stock v
    JOIN stations st ON st.id = v.station_id AND st.active = 1
    WHERE v.is_export = 0
      AND v.is_hidden = 0
      AND v.max_stock > 0
      AND v.max_stock <= @plafond_absurde
      AND v.effective_qty < v.max_stock

    UNION ALL

    SELECT v.station_id, v.item_id, 'export' AS direction,
           v.effective_qty - v.min_stock AS qty,
           CASE WHEN v.max_stock > 0 AND v.effective_qty > v.max_stock
                THEN 1 ELSE 0 END AS urgent
    FROM v_effective_stock v
    JOIN stations st ON st.id = v.station_id AND st.active = 1
    WHERE v.is_export = 1
      AND v.is_hidden = 0
      AND v.effective_qty > v.min_stock
  `).all({ plafond_absurde: PLAFOND_ABSURDE });

  const wanted = new Set(besoins.map(d => `${d.station_id}:${d.item_id}:${d.direction}`));

  // Fermer les missions auto dont le besoin est comblé, sauf si un pilote est en route.
  const autos = db.prepare(`
    SELECT m.id, m.station_id, m.item_id, m.direction,
           (SELECT COUNT(*) FROM mission_claims c
             WHERE c.mission_id = m.id AND c.status = 'in_progress') AS active_claims
    FROM missions m WHERE m.auto = 1 AND m.status = 'open'
  `).all();

  const close = db.prepare(`UPDATE missions SET status='fulfilled', closed_at=datetime('now') WHERE id = ?`);
  for (const m of autos) {
    if (!wanted.has(`${m.station_id}:${m.item_id}:${m.direction}`) && m.active_claims === 0) close.run(m.id);
  }

  const upsert = db.prepare(`
    INSERT INTO missions (station_id, item_id, direction, target_qty, priority, status, auto)
    VALUES (@station_id, @item_id, @direction, @target_qty, @priority, 'open', 1)
    ON CONFLICT(station_id, item_id, direction) WHERE status = 'open'
      DO UPDATE SET target_qty = excluded.target_qty, priority = excluded.priority
  `);

  const dejaManuelle = db.prepare(`
    SELECT 1 FROM missions
    WHERE station_id = ? AND item_id = ? AND direction = ? AND status = 'open' AND auto = 0
  `);

  let created = 0;
  for (const d of besoins) {
    // Une mission ouverte à la main fait autorité : on ne la double pas.
    if (dejaManuelle.get(d.station_id, d.item_id, d.direction)) continue;

    upsert.run({
      station_id: d.station_id,
      item_id: d.item_id,
      direction: d.direction,
      target_qty: Math.max(1, Math.round(d.qty)),
      // L'urgence tient au franchissement du seuil opposé, pas au volume :
      // un gros réapprovisionnement de confort ne doit pas passer devant une
      // station réellement à sec.
      priority: d.urgent ? 'critical' : d.qty >= 500 ? 'high' : 'normal',
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
      m.reward_multiplier,
      st.id AS station_id, st.name AS station_name, st.code AS station_code,
      i.id AS item_id, i.name AS item_name, i.vendor_hint, i.volume AS item_volume,
      COALESCE(v.effective_qty, 0) AS current_qty,
      COALESCE(v.min_stock, 0) AS min_stock,
      COALESCE(v.max_stock, 0) AS max_stock,
      COALESCE(v.risk_bonus, 1) AS risk_bonus,
      -- Une mission créée à la main garde son origine propre ; sinon on
      -- reprend le réglage permanent de la marchandise.
      COALESCE(NULLIF(m.origin, ''), v.origin) AS origin_hint,
      v.destination AS destination_hint,
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
    SELECT c.mission_id, c.user_id, u.display_name, u.callsign, u.avatar, c.pledged_qty
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
      mine: c.user_id === userId,
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

  // Plusieurs pilotes peuvent se partager une mission, mais pas au-delà du
  // besoin : sans ce contrôle, on pouvait s'engager sur une mission déjà
  // entièrement couverte et livrer pour rien.
  const dejaEngage = db.prepare(`
    SELECT COALESCE(SUM(pledged_qty), 0) AS total FROM mission_claims
    WHERE mission_id = ? AND status = 'in_progress'
  `).get(missionId).total;

  const libre = mission.target_qty - dejaEngage;
  if (libre <= 0) {
    return { ok: false, error: 'Cette mission est déjà entièrement couverte.', full: true };
  }

  const demande = Math.max(0, Number(pledgedQty) || 0);
  if (demande > libre) {
    return {
      ok: false,
      error: `Il ne reste que ${libre} unités à couvrir sur cette mission.`,
      available: libre,
    };
  }

  const info = db.prepare(`
    INSERT INTO mission_claims (mission_id, user_id, pledged_qty) VALUES (?, ?, ?)
  `).run(missionId, userId, demande);

  audit(userId, 'mission.claimed', 'missions', missionId, { pledged: demande });
  broadcast('missions:changed', { missionId });
  return { ok: true, claimId: info.lastInsertRowid };
}

/**
 * Le pilote déclare sa livraison. C'est ici que naît le mouvement de stock :
 * un import ajoute, un export retire.
 */
export const deliverClaim = db.transaction((claimId, userId, quantity, note = null) => {
  const claim = db.prepare(`
    SELECT c.*, m.station_id, m.item_id, m.direction, m.target_qty, m.auto,
           m.reward_multiplier, i.volume AS item_volume, i.name AS item_name,
           COALESCE(v.risk_bonus, 1) AS risk_bonus
    FROM mission_claims c
    JOIN missions m ON m.id = c.mission_id
    JOIN items i    ON i.id = m.item_id
    LEFT JOIN v_effective_stock v
           ON v.station_id = m.station_id AND v.item_id = m.item_id
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

  // Points de mérite : quantité × volume unitaire × prime de risque.
  //
  // Le volume égalise l'effort : un vaisseau de 5 000 de soute emporte 5 000
  // unités d'un bien de volume 1, ou 2 500 d'un bien de volume 2. Dans les
  // deux cas le pilote a rempli sa cale et fait le même trajet, donc marque
  // autant. La valeur est figée maintenant : recalculer plus tard réécrirait
  // le classement des mois passés au moindre ajustement.
  const volume = Number(claim.item_volume) > 0 ? Number(claim.item_volume) : 1;
  const primeMission = Number(claim.reward_multiplier) > 0 ? Number(claim.reward_multiplier) : 1;
  // Deux primes se cumulent : celle attachée à la marchandise (danger
  // permanent : territoire pirate, butin sur PNJ) et celle propre à une
  // mission créée à la main pour une circonstance particulière.
  const primeItem = Number(claim.risk_bonus) > 0 ? Number(claim.risk_bonus) : 1;
  const points = Math.round(qty * volume * primeMission * primeItem);

  db.prepare(`
    UPDATE mission_claims
    SET status='delivered', delivered_qty=?, points=?, closed_at=datetime('now')
    WHERE id = ?
  `).run(qty, points, claimId);

  // La mission se ferme si le besoin est couvert et que personne d'autre n'est en route.
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM mission_claims WHERE mission_id = ? AND status = 'in_progress'
  `).get(claim.mission_id).n;

  const stock = db.prepare(`
    SELECT effective_qty, min_stock, max_stock FROM v_effective_stock
    WHERE station_id = ? AND item_id = ?
  `).get(claim.station_id, claim.item_id);

  // Le besoin est couvert quand l'objectif est atteint, pas le seuil d'alerte :
  // la soute pleine à l'import, vidée jusqu'au plancher à l'export.
  const covered = !stock ? true
    : claim.direction === 'export'
      ? stock.effective_qty <= stock.min_stock
      : stock.max_stock > 0 ? stock.effective_qty >= stock.max_stock : true;
  if (remaining === 0 && covered) {
    db.prepare(`UPDATE missions SET status='fulfilled', closed_at=datetime('now') WHERE id = ?`)
      .run(claim.mission_id);
  }

  audit(userId, 'mission.delivered', 'missions', claim.mission_id, { qty, delta });
  broadcast('missions:changed', { missionId: claim.mission_id });
  broadcast('stock:updated', { stationId: claim.station_id });
  return { ok: true, delivered: qty, points };
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
           i.volume AS item_volume, m.reward_multiplier,
           COALESCE(v.risk_bonus, 1) AS risk_bonus,
      -- Une mission créée à la main garde son origine propre ; sinon on
      -- reprend le réglage permanent de la marchandise.
      COALESCE(NULLIF(m.origin, ''), v.origin) AS origin_hint,
      v.destination AS destination_hint,
           m.id AS mission_id, m.direction, m.target_qty, m.origin,
           st.name AS station_name, st.code AS station_code,
           i.name AS item_name, i.vendor_hint
    FROM mission_claims c
    JOIN missions m ON m.id = c.mission_id
    JOIN stations st ON st.id = m.station_id
    JOIN items i ON i.id = m.item_id
    LEFT JOIN v_effective_stock v
           ON v.station_id = m.station_id AND v.item_id = m.item_id
    WHERE c.user_id = ? AND c.status = 'in_progress'
    ORDER BY c.claimed_at
  `).all(userId);
}

/** Classement des pilotes sur une fenêtre glissante. */
/**
 * Classement au mérite.
 *
 * On s'appuie sur les points figés à la livraison, et non sur les unités
 * brutes : celles-ci défavorisaient les marchandises volumineuses, qui
 * demandent pourtant autant de trajets.
 */
/**
 * Classement.
 *
 * La période par défaut est le MOIS CIVIL en cours, et non les trente
 * derniers jours : la répartition des gains se fait au premier du mois sur
 * l'activité du mois écoulé. Une fenêtre glissante ferait sortir du
 * classement des runs qui doivent encore être payés.
 *
 * `period` vaut 'month' (mois en cours), 'last' (mois précédent, utile le
 * jour de la paye) ou 'year'.
 */
export function leaderboard(period = 'month') {
  const FENETRES = {
    month: ["date('now','start of month')", "date('now','start of month','+1 month')"],
    last:  ["date('now','start of month','-1 month')", "date('now','start of month')"],
    year:  ["date('now','start of year')", "date('now','start of year','+1 year')"],
  };
  const [debut, fin] = FENETRES[period] || FENETRES.month;

  return db.prepare(`
    SELECT u.id, u.display_name, u.callsign, u.avatar,
           COUNT(*)             AS runs,
           SUM(c.delivered_qty) AS units,
           SUM(c.points)        AS points
    FROM mission_claims c
    JOIN users u ON u.id = c.user_id
    WHERE c.status = 'delivered'
      AND c.closed_at >= ${debut}
      AND c.closed_at <  ${fin}
    GROUP BY u.id
    ORDER BY points DESC, units DESC
    LIMIT 50
  `).all();
}

/**
 * Fonds des stations et variation depuis le début du mois.
 *
 * L'API ne donne que le solde courant : la variation se calcule contre le
 * premier relevé quotidien du mois. Ce n'est pas un chiffre d'affaires au
 * sens comptable — les dépenses de la station y sont déduites — mais c'est
 * la seule mesure disponible, et c'est celle qui alimente la répartition.
 */
export function monthlyFunds() {
  // Les fonds vivent dans station_status, écrasé à chaque synchronisation.
  const total = db.prepare(`
    SELECT COALESCE(SUM(ss.money), 0) AS v
    FROM station_status ss
    JOIN stations st ON st.id = ss.station_id AND st.active = 1
  `).get().v;

  const base = db.prepare(`
    SELECT COALESCE(SUM(l.money), 0) AS v
    FROM station_funds_log l
    JOIN stations st ON st.id = l.station_id AND st.active = 1
    WHERE l.day = (
      SELECT MIN(day) FROM station_funds_log
      WHERE day >= strftime('%Y-%m-01', 'now')
    )
  `).get().v;

  const parStation = db.prepare(`
    SELECT st.id, st.name, st.code, COALESCE(ss.money, 0) AS money
    FROM stations st
    LEFT JOIN station_status ss ON ss.station_id = st.id
    WHERE st.active = 1 ORDER BY st.sort_order, st.name
  `).all();

  return {
    total,
    baseline: base,
    delta: base > 0 ? total - base : 0,
    hasBaseline: base > 0,
    stations: parStation,
    month: new Date().toISOString().slice(0, 7),
  };
}

/* ------------------------------------------------- historique et annulation */

/**
 * Historique des engagements d'un pilote, du plus récent au plus ancien.
 */
export function claimHistory(userId, limit = 100) {
  return db.prepare(`
    SELECT c.id AS claim_id, c.status, c.pledged_qty, c.delivered_qty, c.points,
           c.claimed_at, c.closed_at, c.cancel_reason,
           m.direction, m.reward_multiplier,
           i.name AS item_name, i.volume AS item_volume,
           st.name AS station_name, st.code AS station_code,
           cb.callsign AS cancelled_by_callsign, cb.display_name AS cancelled_by_name
    FROM mission_claims c
    JOIN missions m  ON m.id  = c.mission_id
    JOIN items i     ON i.id  = m.item_id
    JOIN stations st ON st.id = m.station_id
    LEFT JOIN users cb ON cb.id = c.cancelled_by
    WHERE c.user_id = ? AND c.status <> 'in_progress'
    ORDER BY COALESCE(c.closed_at, c.claimed_at) DESC
    LIMIT ?
  `).all(userId, limit);
}

/**
 * Annule une livraison enregistrée.
 *
 * L'ajustement de stock est supprimé plutôt que compensé : une saisie
 * erronée n'a pas à laisser deux écritures qui s'annulent dans l'historique
 * des stocks. La trace de l'annulation reste sur l'engagement lui-même et
 * dans le journal d'audit.
 */
export const cancelDelivery = db.transaction((claimId, actorId, { isOfficer = false, reason = null } = {}) => {
  const claim = db.prepare(`
    SELECT c.*, m.station_id, m.item_id, m.direction
    FROM mission_claims c JOIN missions m ON m.id = c.mission_id
    WHERE c.id = ?
  `).get(claimId);

  if (!claim) return { ok: false, error: 'Engagement introuvable.' };
  if (claim.status !== 'delivered') {
    return { ok: false, error: 'Seule une livraison enregistrée peut être annulée.' };
  }
  if (claim.user_id !== actorId && !isOfficer) {
    return { ok: false, error: "Cette livraison appartient à un autre pilote." };
  }

  db.prepare(`DELETE FROM stock_adjustments WHERE claim_id = ?`).run(claimId);

  db.prepare(`
    UPDATE mission_claims
    SET status = 'cancelled', points = 0, cancelled_by = ?, cancel_reason = ?,
        closed_at = datetime('now')
    WHERE id = ?
  `).run(actorId, reason, claimId);

  // Le besoin peut être redevenu ouvert : on laisse la génération
  // automatique statuer plutôt que de rouvrir la mission à l'aveugle.
  refreshAutoMissions();

  return { ok: true, restored: claim.delivered_qty };
});
