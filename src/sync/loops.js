/* =====================================================================
   Boucles de trade.

   Une suggestion aller simple laisse le pilote rentrer à vide. Ce qu'il
   veut est un circuit :

       Base A  --(ce que la station attend)-->  Notre station S
       S       --(ce que la station produit)-->  Base B
       B       --(retour)-------------------->  A

   Le circuit est donc l'assemblage de DEUX missions ouvertes sur la même
   station : une d'import, une d'export. Le reste — quelle base fournit,
   quelle base achète — vient du marché, exactement comme pour les routes.

   Critère de classement : POINTS PAR SECONDE, jamais la marge brute. Un
   pilote arbitre sur le temps qu'il y passe. C'est aussi ce qui permet
   d'autoriser la traversée des régions sans garde-fou supplémentaire : un
   circuit qui traverse la galaxie pour cent crédits s'élimine tout seul,
   sans qu'on ait à interdire quoi que ce soit.

   Ni les quantités ni les points ne sont stockés : ils dépendent de la
   cale du pilote qui consulte. Voir `src/services/loops.js`, qui les
   recalcule à la lecture.
   ===================================================================== */

import { config } from '../config.js';
import { db, nowSql } from '../db/index.js';
import { broadcast } from '../services/events.js';
import { lireMarche, meilleuresOffres } from './routes.js';
import { tempsDeTrajet, secondes } from './paths.js';

/* ------------------------------------------------------------ mesures */

/** Volume unitaire exploitable. Une marchandise sans volume vaut 1. */
const volumeDe = (v) => (Number(v) > 0 ? Number(v) : 1);

/** Prime cumulée : celle de la mission et celle de la marchandise. */
function multiplicateur(mission) {
  const primeMission = Number(mission.reward_multiplier) > 0 ? Number(mission.reward_multiplier) : 1;
  const primeItem = Number(mission.risk_bonus) > 0 ? Number(mission.risk_bonus) : 1;
  return primeMission * primeItem;
}

/**
 * Points d'un segment pour une cale donnée.
 *
 * Reprend exactement la formule figée à la livraison dans
 * `deliverClaim` : quantité × volume × primes. Une estimation qui
 * divergerait de ce que le pilote touchera réellement serait pire que pas
 * d'estimation du tout.
 *
 * La quantité est bornée par ce qui reste à couvrir : proposer une cale
 * pleine sur une mission qui n'attend plus que 40 unités gonflerait le
 * score d'un circuit sans intérêt.
 */
export function pointsSegment({ openQty, volume, multiplier }, cale) {
  const vol = volumeDe(volume);
  const tenable = Math.floor(Math.max(0, cale) / vol);
  const qty = Math.max(0, Math.min(Number(openQty) || 0, tenable));
  return { qty, points: Math.round(qty * vol * (Number(multiplier) || 1)) };
}

/* ------------------------------------------------------------ lecture */

/**
 * Missions ouvertes exploitables pour un circuit.
 *
 * Trois conditions, chacune éliminatoire :
 *
 *  - la marchandise doit porter un `commodity_id`, sans quoi on ne sait
 *    pas la retrouver dans le marché ;
 *  - la station doit porter son `api_nickname`, car /api/graph/paths
 *    refuse les noms affichés ;
 *  - il doit rester quelque chose à couvrir une fois les engagements en
 *    cours déduits.
 */
function missionsExploitables() {
  return db.prepare(`
    SELECT
      m.id AS mission_id, m.station_id, m.direction, m.target_qty,
      m.reward_multiplier,
      st.api_nickname AS station_nick, st.name AS station_name, st.code AS station_code,
      i.id AS item_id, i.name AS item_name, i.commodity_id, i.volume,
      COALESCE(v.risk_bonus, 1) AS risk_bonus,
      m.target_qty - (
        SELECT COALESCE(SUM(c.pledged_qty), 0) FROM mission_claims c
        WHERE c.mission_id = m.id AND c.status = 'in_progress'
      ) - CASE WHEN m.auto = 1 THEN 0 ELSE (
        -- Une mission créée à la main garde l'objectif fixé par l'officier :
        -- ce sont les livraisons cumulées qui l'entament. Celui d'une mission
        -- automatique est recalculé d'après le stock, elles y sont déjà.
        SELECT COALESCE(SUM(c.delivered_qty), 0) FROM mission_claims c
        WHERE c.mission_id = m.id AND c.status = 'delivered'
      ) END AS open_qty
    FROM missions m
    JOIN items    i  ON i.id  = m.item_id
    JOIN stations st ON st.id = m.station_id AND st.active = 1
    LEFT JOIN v_effective_stock v
           ON v.station_id = m.station_id AND v.item_id = m.item_id
    WHERE m.status = 'open'
      AND i.commodity_id IS NOT NULL AND i.commodity_id <> ''
      AND st.api_nickname IS NOT NULL AND st.api_nickname <> ''
  `).all().filter((m) => m.open_qty > 0);
}

/* ------------------------------------------------------------- calcul */

/**
 * Reconstruit l'intégralité des circuits.
 *
 * Le déroulé est en trois temps, pour que le nombre de couples mesurés
 * reste borné. Éprouver tous les retours possibles coûterait le carré du
 * nombre de candidats ; on ne mesure les retours qu'entre les meilleurs
 * segments de chaque bord.
 */
export const analyserBoucles = async () => {
  const missions = missionsExploitables();
  if (!missions.length) {
    return { ok: true, stations: 0, boucles: 0, note: 'Aucune mission exploitable.' };
  }

  const marche = await lireMarche();
  if (!marche.size) {
    return { ok: false, error: 'Aucune donnée de marché exploitable.' };
  }

  const interdites = new Set(
    db.prepare('SELECT faction_name FROM blocked_factions').all()
      .map((r) => String(r.faction_name).toLowerCase())
  );

  const { offresParMission, segmentsParBord, parStation, refCargo } = config.loops;

  /* --- 1. Candidats -------------------------------------------------- */

  // Un segment = une mission ouverte + une base capable de la servir.
  const parStationMap = new Map();

  for (const m of missions) {
    const offres = meilleuresOffres(
      marche.get(m.commodity_id), m.direction, interdites, m.station_nick, offresParMission);

    for (const o of offres) {
      // Un prix agrégé n'a pas de base nommée : inutilisable pour un
      // circuit, qui doit dire au pilote où se poser. Les routes s'en
      // contentent car elles n'affichent qu'une indication de prix.
      if (!o.baseNickname) continue;

      if (!parStationMap.has(m.station_id)) {
        parStationMap.set(m.station_id, { station: m, entrants: [], sortants: [] });
      }
      const groupe = parStationMap.get(m.station_id);
      const segment = {
        mission: m,
        base: o,
        prix: m.direction === 'import' ? o.prixAchat : o.prixVente,
        volume: volumeDe(m.volume),
        multiplier: multiplicateur(m),
      };
      (m.direction === 'import' ? groupe.entrants : groupe.sortants).push(segment);
    }
  }

  /* --- 2. Temps des allers ------------------------------------------- */

  const couples = [];
  for (const g of parStationMap.values()) {
    const nick = g.station.station_nick;
    for (const s of g.entrants) couples.push([s.base.baseNickname, nick]);
    for (const s of g.sortants) couples.push([nick, s.base.baseNickname]);
  }

  const allers = await tempsDeTrajet(couples);

  // Un segment dont le trajet est inconnu ou injoignable n'existe pas.
  // ~12 % des bases PNJ sont absentes du graphe de darkstat.
  const noteSegment = (s, from, to) => {
    s.secondes = secondes(allers, from, to, 'transport');
    const { qty, points } = pointsSegment(
      { openQty: s.mission.open_qty, volume: s.volume, multiplier: s.multiplier }, refCargo);
    s.refQty = qty;
    s.refPoints = points;
    return s.secondes != null && qty > 0;
  };

  for (const g of parStationMap.values()) {
    const nick = g.station.station_nick;
    g.entrants = g.entrants
      .filter((s) => noteSegment(s, s.base.baseNickname, nick))
      .sort((a, b) => b.refPoints / b.secondes - a.refPoints / a.secondes)
      .slice(0, segmentsParBord);
    g.sortants = g.sortants
      .filter((s) => noteSegment(s, nick, s.base.baseNickname))
      .sort((a, b) => b.refPoints / b.secondes - a.refPoints / a.secondes)
      .slice(0, segmentsParBord);
  }

  /* --- 3. Temps des retours ------------------------------------------ */

  const retoursVoulus = [];
  for (const g of parStationMap.values()) {
    for (const s of g.sortants) {
      for (const e of g.entrants) {
        // Quand la base acheteuse est aussi la base fournisseuse, le
        // circuit se referme sur place : il n'y a pas de retour à mesurer.
        if (s.base.baseNickname !== e.base.baseNickname) {
          retoursVoulus.push([s.base.baseNickname, e.base.baseNickname]);
        }
      }
    }
  }
  const retours = await tempsDeTrajet(retoursVoulus);

  /* --- 4. Assemblage et classement ------------------------------------ */

  const stamp = nowSql();
  const retenues = [];

  for (const g of parStationMap.values()) {
    const candidats = [];

    for (const e of g.entrants) {
      for (const s of g.sortants) {
        const memeBase = e.base.baseNickname === s.base.baseNickname;
        const retour = memeBase ? 0 : secondes(retours, s.base.baseNickname, e.base.baseNickname, 'transport');
        if (retour == null) continue;

        const total = e.secondes + s.secondes + retour;
        if (!(total > 0)) continue;

        candidats.push({
          station: g.station,
          entrant: e,
          sortant: s,
          ref_score: (e.refPoints + s.refPoints) / total,
        });
      }
    }

    candidats.sort((a, b) => b.ref_score - a.ref_score);
    retenues.push(...candidats.slice(0, parStation));
  }

  /* --- 5. Écriture ---------------------------------------------------- */

  const poser = db.prepare(`
    INSERT INTO trade_loops (
      station_id, station_nick,
      in_mission_id, in_item_id, in_base_nick, in_base_name, in_faction,
      in_system, in_sector, in_region, in_price, in_open_qty, in_volume, in_multiplier,
      out_mission_id, out_item_id, out_base_nick, out_base_name, out_faction,
      out_system, out_sector, out_region, out_price, out_open_qty, out_volume, out_multiplier,
      ref_score, computed_at
    ) VALUES (
      @station_id, @station_nick,
      @in_mission_id, @in_item_id, @in_base_nick, @in_base_name, @in_faction,
      @in_system, @in_sector, @in_region, @in_price, @in_open_qty, @in_volume, @in_multiplier,
      @out_mission_id, @out_item_id, @out_base_nick, @out_base_name, @out_faction,
      @out_system, @out_sector, @out_region, @out_price, @out_open_qty, @out_volume, @out_multiplier,
      @ref_score, @computed_at
    )
    ON CONFLICT(station_id, in_item_id, in_base_nick, out_item_id, out_base_nick)
      DO UPDATE SET ref_score = excluded.ref_score, computed_at = excluded.computed_at
  `);

  const appliquer = db.transaction(() => {
    // Comme les routes automatiques : les circuits sont entièrement
    // dérivés du marché, jamais saisis. On les purge et on les refait.
    db.prepare('DELETE FROM trade_loops').run();

    for (const c of retenues) {
      poser.run({
        station_id: c.station.station_id,
        station_nick: c.station.station_nick,

        in_mission_id: c.entrant.mission.mission_id,
        in_item_id: c.entrant.mission.item_id,
        in_base_nick: c.entrant.base.baseNickname,
        in_base_name: c.entrant.base.baseName,
        in_faction: c.entrant.base.faction,
        in_system: c.entrant.base.system,
        in_sector: c.entrant.base.secteur,
        in_region: c.entrant.base.region,
        in_price: c.entrant.prix,
        in_open_qty: c.entrant.mission.open_qty,
        in_volume: c.entrant.volume,
        in_multiplier: c.entrant.multiplier,

        out_mission_id: c.sortant.mission.mission_id,
        out_item_id: c.sortant.mission.item_id,
        out_base_nick: c.sortant.base.baseNickname,
        out_base_name: c.sortant.base.baseName,
        out_faction: c.sortant.base.faction,
        out_system: c.sortant.base.system,
        out_sector: c.sortant.base.secteur,
        out_region: c.sortant.base.region,
        out_price: c.sortant.prix,
        out_open_qty: c.sortant.mission.open_qty,
        out_volume: c.sortant.volume,
        out_multiplier: c.sortant.multiplier,

        ref_score: c.ref_score,
        computed_at: stamp,
      });
    }
  });
  appliquer();

  broadcast('loops:changed', { count: retenues.length });
  return {
    ok: true,
    stations: parStationMap.size,
    boucles: retenues.length,
    couplesMesures: couples.length + retoursVoulus.length,
  };
};
