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
import { activeShip, shipOf, baremeDesSoutes } from './hangar.js';

export const CLASSE_PAR_DEFAUT = 'transport';

/**
 * Cale retenue pour un pilote : celle de son vaisseau actif.
 *
 * Tant que son hangar est vide, on met les circuits à l'échelle d'une cale
 * de référence et l'écran l'annonce : mieux vaut un chiffre affiché comme
 * approximatif qu'un écran vide en attendant un réglage.
 */
export function caleDe(user, shipId = null) {
  // Un vaisseau du hangar désigné par l'écran l'emporte sur l'actif.
  const choisi = user?.id != null && shipId != null ? shipOf(user.id, shipId) : null;
  const ship = choisi || (user?.id != null ? activeShip(user.id) : null);
  const valide = !!ship && ship.hold > 0;
  return {
    cargo: valide ? ship.hold : config.loops.refCargo,
    shipClass: ship && CLASSES.includes(ship.shipClass) ? ship.shipClass : CLASSE_PAR_DEFAUT,
    // La classe au sens du jeu, pour les marchandises qu'elle emporte à
    // volume réduit.
    gameClass: valide ? ship.gameClass : null,
    declaree: valide,
    choisi: !!choisi && valide,
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
    ii.name AS in_item_name,  ii.commodity_id AS in_commodity,
    oi.name AS out_item_name, oi.commodity_id AS out_commodity,
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
export function listLoops({ user, stationId = null, cargo = null, shipClass = null, shipId = null } = {}) {
  const reglage = caleDe(user, shipId);

  // Une cale passée dans l'URL l'emporte sur le profil : le pilote essaie
  // un autre vaisseau sans avoir à modifier son réglage permanent. Un
  // vaisseau du hangar désigné par son identifiant prime sur les deux : sa
  // soute et son allure se lisent sur son modèle.
  const demandee = reglage.choisi ? NaN : Number(cargo);
  const simulee = Number.isFinite(demandee) && demandee > 0;
  const cale = simulee ? Math.round(demandee) : reglage.cargo;
  const classe = !reglage.choisi && CLASSES.includes(shipClass) ? shipClass : reglage.shipClass;

  // Une cale simulée n'est celle d'aucun modèle : elle n'a pas de classe,
  // donc aucun volume réduit à faire valoir.
  const gameClass = simulee ? null : reglage.gameClass;
  const bareme = gameClass == null ? null : baremeDesSoutes();
  const enSoute = (nick, reference) => bareme?.get(nick)?.[gameClass] ?? reference;

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
      { openQty: l.in_open_qty, volume: l.in_volume, multiplier: l.in_multiplier,
        holdVolume: enSoute(l.in_commodity, l.in_volume) }, cale);
    const sortant = pointsSegment(
      { openQty: l.out_open_qty, volume: l.out_volume, multiplier: l.out_multiplier,
        holdVolume: enSoute(l.out_commodity, l.out_volume) }, cale);

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
    usingDefaultCargo: !reglage.declaree && !simulee,
    computedAt: lignes[0]?.computed_at ?? null,
    loops: sorties,
  };
}
