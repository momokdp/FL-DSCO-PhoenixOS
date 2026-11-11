/* =====================================================================
   Le hangar d'un pilote.

   Un pilote tient plusieurs vaisseaux, chacun rattaché à un modèle du
   catalogue relevé sur darkstat. La soute d'un vaisseau n'est jamais
   saisie : elle se lit sur son modèle, au moment où on en a besoin. Une
   mise à jour du jeu qui la change vaut donc aussitôt pour tous.

   Trois usages en dépendent :
     * la prise de mission, qui retient le vaisseau engagé ;
     * la livraison, plafonnée à ce que ce vaisseau emporte ;
     * les circuits, mis à l'échelle du vaisseau actif.
   ===================================================================== */

import { db, audit } from '../db/index.js';

// Les temps de trajet de darkstat ne connaissent que ces trois allures.
// La liste est redite ici plutôt qu'importée de `sync/paths.js` : ce
// module-ci est lu par `missions.js`, que le relevé importe à son tour.
const ALLURES = ['transport', 'freighter', 'frigate'];

// Au-delà, le hangar n'est plus une flotte mais une saisie en boucle.
const VAISSEAUX_MAX = 30;
const NOM_MAX = 40;

/**
 * Allure de vol d'un modèle, pour le calcul des temps de trajet.
 *
 * darkstat classe les vaisseaux en six types mais ne mesure les trajets
 * que pour trois allures. Tout ce qui n'est ni transport ni cargo léger
 * vole à l'allure « frigate », la seule restante.
 */
export function allureDe(type) {
  if (type === 'transport' || type === 'freighter') return type;
  return 'frigate';
}

/**
 * Nombre d'unités d'une marchandise qu'une soute emporte.
 *
 * La marge d'un millionième absorbe l'arrondi des volumes décimaux :
 * 4 700 / 0,2 doit donner 23 500, pas 23 499 parce que 0,2 n'a pas
 * d'écriture exacte en binaire.
 */
export function unitesTenables(soute, volume) {
  const vol = Number(volume) > 0 ? Number(volume) : 1;
  const cale = Number(soute);
  if (!Number.isFinite(cale) || cale <= 0) return 0;
  return Math.floor(cale / vol + 1e-6);
}

const SELECTION = `
  SELECT ps.id, ps.user_id, ps.name, ps.model_nick, ps.legacy_cargo, ps.legacy_class,
         ps.created_at, ps.retired_at,
         sm.name AS model_name, sm.type AS model_type,
         sm.hold_size AS model_hold, sm.present AS model_present
  FROM pilot_ships ps
  LEFT JOIN ship_models sm ON sm.nickname = ps.model_nick
`;

/** Forme rendue à l'écran, et aux autres services. */
function versVaisseau(l, activeId = null) {
  const rattache = l.model_nick != null && l.model_name != null;
  return {
    id: l.id,
    name: l.name,
    model: rattache
      ? { nickname: l.model_nick, name: l.model_name, type: l.model_type,
          // Le modèle a quitté le catalogue : sa dernière soute connue
          // reste valable, mais l'écran doit pouvoir le signaler.
          retiredFromGame: !l.model_present }
      : null,
    // Sans modèle, on ne connaît que la cale autrefois déclarée.
    hold: rattache ? l.model_hold : (l.legacy_cargo ?? 0),
    shipClass: rattache
      ? allureDe(l.model_type)
      : (ALLURES.includes(l.legacy_class) ? l.legacy_class : 'transport'),
    // Seul un vaisseau rattaché peut prendre une mission : sa soute vient
    // du jeu, pas d'une saisie.
    usable: rattache,
    active: l.id === activeId,
  };
}

const activeDe = (userId) =>
  db.prepare('SELECT active_ship_id AS id FROM users WHERE id = ?').get(userId)?.id ?? null;

/** Les vaisseaux en service d'un pilote, l'actif en tête. */
export function listShips(userId) {
  const activeId = activeDe(userId);
  const ships = db.prepare(`${SELECTION}
    WHERE ps.user_id = ? AND ps.retired_at IS NULL
    ORDER BY ps.id
  `).all(userId).map((l) => versVaisseau(l, activeId));

  ships.sort((a, b) => Number(b.active) - Number(a.active));
  return {
    ships,
    activeShipId: ships.some((s) => s.active) ? activeId : null,
    // Faux tant que darkstat n'a jamais rendu son catalogue : l'écran sait
    // alors qu'on peut prendre une mission sans vaisseau.
    catalogReady: !catalogueVide(),
  };
}

/** Un vaisseau en service du pilote, ou null. */
export function shipOf(userId, shipId) {
  const id = Number(shipId);
  if (!Number.isInteger(id)) return null;
  const l = db.prepare(`${SELECTION}
    WHERE ps.id = ? AND ps.user_id = ? AND ps.retired_at IS NULL
  `).get(id, userId);
  return l ? versVaisseau(l, activeDe(userId)) : null;
}

/** Le vaisseau actif du pilote, ou null s'il n'en a pas. */
export function activeShip(userId) {
  const id = activeDe(userId);
  return id == null ? null : shipOf(userId, id);
}

/** Vrai tant qu'aucun relevé du catalogue n'a abouti. */
export function catalogueVide() {
  return db.prepare('SELECT 1 FROM ship_models LIMIT 1').get() === undefined;
}

/** Les modèles proposés au choix : ceux encore présents dans le jeu. */
export function listModels() {
  return db.prepare(`
    SELECT nickname, name, type, hold_size AS hold
    FROM ship_models WHERE present = 1
    ORDER BY name COLLATE NOCASE, hold_size
  `).all();
}

const modele = (nickname) => (typeof nickname !== 'string' ? null
  : db.prepare('SELECT * FROM ship_models WHERE nickname = ? AND present = 1').get(nickname));

/** Nom nettoyé : une ligne, sans caractère de contrôle, de longueur bornée. */
function nomPropre(valeur) {
  if (typeof valeur !== 'string') return '';
  return valeur.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOM_MAX);
}

/** Ajoute un vaisseau au hangar. Le premier devient actif d'office. */
export const addShip = db.transaction((userId, { model, name } = {}) => {
  const m = modele(model);
  if (!m) return { ok: false, error: 'Choisissez un modèle dans le catalogue.' };

  const { n } = db.prepare(
    'SELECT COUNT(*) AS n FROM pilot_ships WHERE user_id = ? AND retired_at IS NULL').get(userId);
  if (n >= VAISSEAUX_MAX) {
    return { ok: false, error: `Un hangar compte au plus ${VAISSEAUX_MAX} vaisseaux. Retirez-en un d'abord.` };
  }

  const info = db.prepare(
    'INSERT INTO pilot_ships (user_id, model_nick, name) VALUES (?, ?, ?)',
  ).run(userId, m.nickname, nomPropre(name) || m.name);
  const id = Number(info.lastInsertRowid);

  // Sans vaisseau actif valide, celui-ci le devient : le pilote qui vient
  // d'ajouter son premier vaisseau n'a pas à le désigner en plus.
  if (!activeShip(userId)) {
    db.prepare('UPDATE users SET active_ship_id = ? WHERE id = ?').run(id, userId);
  }

  audit(userId, 'ship.added', 'pilot_ships', id, { model: m.nickname });
  return { ok: true, ship: shipOf(userId, id) };
});

/**
 * Renomme un vaisseau, ou rattache à un modèle un vaisseau repris de
 * l'ancienne déclaration.
 *
 * Un vaisseau déjà rattaché ne change pas de modèle : les livraisons
 * faites avec lui passeraient d'un coup pour faites avec un autre. Pour
 * changer de vaisseau, on en ajoute un.
 */
export const updateShip = db.transaction((userId, shipId, { model, name } = {}) => {
  const actuel = shipOf(userId, shipId);
  if (!actuel) return { ok: false, error: 'Ce vaisseau ne figure pas dans votre hangar.' };

  if (model !== undefined && model !== null && model !== actuel.model?.nickname) {
    if (actuel.model) {
      return { ok: false, error: 'Le modèle d’un vaisseau ne se change pas. Ajoutez-en un autre.' };
    }
    const m = modele(model);
    if (!m) return { ok: false, error: 'Choisissez un modèle dans le catalogue.' };
    db.prepare('UPDATE pilot_ships SET model_nick = ? WHERE id = ?').run(m.nickname, actuel.id);
  }

  if (name !== undefined) {
    const propre = nomPropre(name);
    if (!propre) return { ok: false, error: 'Donnez un nom à ce vaisseau.' };
    db.prepare('UPDATE pilot_ships SET name = ? WHERE id = ?').run(propre, actuel.id);
  }

  return { ok: true, ship: shipOf(userId, actuel.id) };
});

/** Désigne le vaisseau proposé par défaut. */
export function activateShip(userId, shipId) {
  const ship = shipOf(userId, shipId);
  if (!ship) return { ok: false, error: 'Ce vaisseau ne figure pas dans votre hangar.' };
  db.prepare('UPDATE users SET active_ship_id = ? WHERE id = ?').run(ship.id, userId);
  return { ok: true, ship: { ...ship, active: true } };
}

/**
 * Retire un vaisseau du hangar.
 *
 * La ligne reste en base : les livraisons passées y renvoient. Un
 * vaisseau engagé sur une mission en cours ne se retire pas — c'est sa
 * soute qui plafonnera la livraison.
 */
export const retireShip = db.transaction((userId, shipId) => {
  const ship = shipOf(userId, shipId);
  if (!ship) return { ok: false, error: 'Ce vaisseau ne figure pas dans votre hangar.' };

  const engage = db.prepare(`
    SELECT 1 FROM mission_claims WHERE ship_id = ? AND status = 'in_progress' LIMIT 1
  `).get(ship.id);
  if (engage) {
    return { ok: false, error: 'Ce vaisseau est engagé sur une mission. Livrez ou désengagez-vous d’abord.' };
  }

  db.prepare(`UPDATE pilot_ships SET retired_at = datetime('now') WHERE id = ?`).run(ship.id);

  if (ship.active) {
    // L'actif part : le plus ancien vaisseau restant prend sa place, pour
    // ne pas laisser le pilote sans vaisseau proposé.
    const suivant = db.prepare(`
      SELECT id FROM pilot_ships WHERE user_id = ? AND retired_at IS NULL ORDER BY id LIMIT 1
    `).get(userId);
    db.prepare('UPDATE users SET active_ship_id = ? WHERE id = ?').run(suivant?.id ?? null, userId);
  }

  audit(userId, 'ship.retired', 'pilot_ships', ship.id, null);
  return { ok: true };
});

/**
 * Le vaisseau à engager sur une mission.
 *
 * Sans identifiant, c'est le vaisseau actif. Tant que le catalogue n'a
 * jamais été relevé, personne ne peut rattacher de vaisseau : on laisse
 * alors passer l'engagement sans vaisseau plutôt que de bloquer toute la
 * console sur une panne de darkstat.
 */
export function shipForClaim(userId, shipId = null) {
  if (catalogueVide()) return { ok: true, ship: null };

  const ship = shipId != null ? shipOf(userId, shipId) : activeShip(userId);
  if (!ship) {
    return {
      ok: false, needShip: true,
      error: shipId != null
        ? 'Ce vaisseau ne figure pas dans votre hangar.'
        : 'Ajoutez un vaisseau à votre hangar avant de prendre une mission.',
    };
  }
  if (!ship.usable) {
    return {
      ok: false, needShip: true,
      error: `Précisez le modèle de « ${ship.name} » dans votre hangar avant de prendre une mission.`,
    };
  }
  return { ok: true, ship };
}
