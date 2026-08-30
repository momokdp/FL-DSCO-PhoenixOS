/* =====================================================================
   Lecture des boucles de trade.

   Le calcul horaire fige la TOPOLOGIE d'un circuit — quelles bases,
   quelles missions, quels prix — mais jamais les quantités ni les points :
   ceux-ci dépendent de la cale du pilote qui consulte, et deux pilotes
   regardant le même circuit n'y liront pas le même chiffre.

   Les temps de trajet ne sont pas recopiés non plus. Ils vivent dans
   `path_times`, d'où on les relit par jointure sur les trois nicknames du
   circuit : c'est ce qui permet de rendre le temps du vaisseau réellement
   piloté au lieu d'un transport supposé.
   ===================================================================== */

import { config } from '../config.js';
import { db } from '../db/index.js';
import { CLASSES } from '../sync/paths.js';
import { pointsSegment } from '../sync/loops.js';

export const CLASSE_PAR_DEFAUT = 'transport';

/**
 * Cale retenue pour un pilote.
 *
 * Tant qu'il n'a rien déclaré, on met les circuits à l'échelle d'une cale
 * de référence et l'écran l'annonce : mieux vaut un chiffre affiché comme
 * approximatif qu'un écran vide en attendant un réglage.
 */
export function caleDe(user) {
  const declaree = Number(user?.cargo_capacity);
  const valide = Number.isFinite(declaree) && declaree > 0;
  return {
    cargo: valide ? Math.round(declaree) : config.loops.refCargo,
    shipClass: CLASSES.includes(user?.ship_class) ? user.ship_class : CLASSE_PAR_DEFAUT,
    declaree: valide,
  };
}

/**
 * Préparée à la première lecture, jamais au chargement du module : les
 * imports ESM s'évaluent avant que `server.js` n'appelle `migrate()`, et
 * `trade_loops` n'existe pas encore sur une base déjà déployée.
 */
let lecture = null;
const LECTURE = () => (lecture ||= db.prepare(`
  SELECT
    l.*,
    st.name AS station_name, st.code AS station_code,
    ii.name AS in_item_name,
    oi.name AS out_item_name,
    pin.transport   AS in_transport,   pin.frigate   AS in_frigate,   pin.freighter   AS in_freighter,
    pout.transport  AS out_transport,  pout.frigate  AS out_frigate,  pout.freighter  AS out_freighter,
    pback.transport AS back_transport, pback.frigate AS back_frigate, pback.freighter AS back_freighter,
    pin.reachable   AS in_reachable,
    pout.reachable  AS out_reachable,
    pback.reachable AS back_reachable
  FROM trade_loops l
  JOIN stations st ON st.id = l.station_id
  JOIN items    ii ON ii.id = l.in_item_id
  JOIN items    oi ON oi.id = l.out_item_id
  LEFT JOIN path_times pin
         ON pin.from_nick   = l.in_base_nick  AND pin.to_nick   = l.station_nick
  LEFT JOIN path_times pout
         ON pout.from_nick  = l.station_nick  AND pout.to_nick  = l.out_base_nick
  LEFT JOIN path_times pback
         ON pback.from_nick = l.out_base_nick AND pback.to_nick = l.in_base_nick
  WHERE (@station_id IS NULL OR l.station_id = @station_id)
`));

/**
 * Circuits proposés, mis à l'échelle d'une cale et d'un type de vaisseau.
 *
 * Le classement se fait sur les POINTS PAR HEURE. C'est la mesure sur
 * laquelle un pilote arbitre réellement : deux circuits rapportant autant
 * ne se valent pas si l'un prend le double de temps. C'est aussi ce qui
 * rend inutile toute règle interdisant de changer de région — un long
 * détour se disqualifie de lui-même.
 */
export function listLoops({ user, stationId = null, cargo = null, shipClass = null } = {}) {
  const reglage = caleDe(user);

  // Une cale passée dans l'URL l'emporte sur le profil : le pilote essaie
  // un autre vaisseau sans avoir à modifier son réglage permanent.
  const demandee = Number(cargo);
  const cale = Number.isFinite(demandee) && demandee > 0
    ? Math.round(demandee)
    : reglage.cargo;
  const classe = CLASSES.includes(shipClass) ? shipClass : reglage.shipClass;

  const lignes = LECTURE().all({ station_id: stationId });
  const sorties = [];

  for (const l of lignes) {
    const memeBase = l.in_base_nick === l.out_base_nick;

    const tEntrant = l[`in_${classe}`];
    const tSortant = l[`out_${classe}`];
    // Quand la base acheteuse est aussi la base fournisseuse, le circuit
    // se referme sur place : il n'y a pas de retour, et pas de ligne dans
    // path_times à attendre.
    const tRetour = memeBase ? 0 : l[`back_${classe}`];

    // Un temps manquant n'est pas un temps nul. Un circuit dont un segment
    // n'est pas mesurable ne peut pas être classé, donc pas proposé.
    if (![tEntrant, tSortant, tRetour].every((v) => Number.isFinite(v) && v >= 0)) continue;
    const total = tEntrant + tSortant + tRetour;
    if (!(total > 0)) continue;

    const entrant = pointsSegment(
      { openQty: l.in_open_qty, volume: l.in_volume, multiplier: l.in_multiplier }, cale);
    const sortant = pointsSegment(
      { openQty: l.out_open_qty, volume: l.out_volume, multiplier: l.out_multiplier }, cale);

    const points = entrant.points + sortant.points;
    if (points <= 0) continue;

    sorties.push({
      id: l.id,
      station: { id: l.station_id, name: l.station_name, code: l.station_code },

      inbound: {
        missionId: l.in_mission_id,
        itemId: l.in_item_id,
        itemName: l.in_item_name,
        baseName: l.in_base_name || l.in_base_nick,
        baseNickname: l.in_base_nick,
        faction: l.in_faction,
        system: l.in_system,
        sector: l.in_sector,
        region: l.in_region,
        unitPrice: l.in_price,
        openQty: l.in_open_qty,
        volume: l.in_volume,
        qty: entrant.qty,
        points: entrant.points,
        seconds: tEntrant,
        // Ce que la cargaison coûte au départ : la base nous la vend.
        cost: l.in_price != null ? Math.round(entrant.qty * l.in_price) : null,
      },

      outbound: {
        missionId: l.out_mission_id,
        itemId: l.out_item_id,
        itemName: l.out_item_name,
        baseName: l.out_base_name || l.out_base_nick,
        baseNickname: l.out_base_nick,
        faction: l.out_faction,
        system: l.out_system,
        sector: l.out_sector,
        region: l.out_region,
        unitPrice: l.out_price,
        openQty: l.out_open_qty,
        volume: l.out_volume,
        qty: sortant.qty,
        points: sortant.points,
        seconds: tSortant,
        // Ce que la revente rapporte : la base nous la paie.
        revenue: l.out_price != null ? Math.round(sortant.qty * l.out_price) : null,
      },

      returnSeconds: tRetour,
      // Le circuit se referme sur la base de départ : le pilote peut
      // enchaîner sans repositionnement.
      closesOnItself: memeBase,

      totalSeconds: total,
      points,
      // Points par heure : l'unité à laquelle un pilote compare deux vols.
      pointsPerHour: Math.round((points / total) * 3600),
      computedAt: l.computed_at,
    });
  }

  sorties.sort((a, b) => b.pointsPerHour - a.pointsPerHour);

  return {
    cargo: cale,
    shipClass: classe,
    // L'écran doit pouvoir dire « estimé sur une cale de référence » tant
    // que le pilote n'a pas déclaré la sienne.
    usingDefaultCargo: !reglage.declaree && !(Number.isFinite(demandee) && demandee > 0),
    computedAt: lignes[0]?.computed_at ?? null,
    loops: sorties,
  };
}

/**
 * Enregistre la cale du pilote.
 *
 * Bornée haut pour écarter une saisie absurde : le plus gros transport du
 * jeu reste très en deçà, et un chiffre démesuré ferait passer tous les
 * circuits pour illimités en écrasant les quantités encore à couvrir.
 */
export function setShip(userId, { cargo, shipClass }) {
  const brut = Number(cargo);
  const cale = brut === null || brut === undefined || Number.isNaN(brut) || brut <= 0
    ? null
    : Math.min(100_000, Math.round(brut));

  const classe = CLASSES.includes(shipClass) ? shipClass : null;

  db.prepare('UPDATE users SET cargo_capacity = ?, ship_class = ? WHERE id = ?')
    .run(cale, classe, userId);

  return { ok: true, cargo: cale, shipClass: classe };
}
