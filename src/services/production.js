/* =====================================================================
   Arsenal : catalogue des recettes, modules des stations, file de
   production.

   Le serveur tient les faits — recettes, stocks, commandes. Le calcul de
   ce qu'une commande réclame et de ce qui manque se fait dans le
   navigateur (public/js/production-calc.js) : il doit répondre à chaque
   chiffre tapé dans un brouillon de commande, sans aller-retour.
   ===================================================================== */

import { db, audit, nowSql, getSetting } from '../db/index.js';

const estOfficier = (user) => user?.role === 'officer' || user?.role === 'admin';

const QUANTITE_MAX = 1_000_000;
const LIGNES_MAX = 60;

const texte = (v, max) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};
const entier = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };

const echec = (error, code = 400) => ({ ok: false, error, code });

/* ----------------------------------------------------------- lecture */

function recettes(nicksCommandes) {
  // Une recette retirée du jeu reste servie tant qu'une commande ouverte
  // la réclame : sa ligne doit continuer de savoir ce qu'elle consomme.
  const lignes = db.prepare('SELECT * FROM craft_recipes ORDER BY name, nickname').all();
  return lignes
    .filter((r) => r.present || nicksCommandes.has(r.nickname))
    .map((r) => {
      let detail = {};
      try { detail = JSON.parse(r.detail); } catch { /* recette illisible : servie sans ingrédients */ }
      return {
        nick: r.nickname, name: r.name, product: r.product_nick, category: r.category,
        craftType: r.craft_type, factory: r.factory, command: r.command,
        minutes: r.minutes, volume: r.total_volume, level: r.req_level,
        loops: !!r.loops, restricted: !!r.restricted, retired: !r.present,
        infotext: detail.infotext || null,
        produced: detail.produced || [], consumed: detail.consumed || [],
        choices: detail.choices || [], catalysts: detail.catalysts || [],
        bonuses: detail.bonuses || [],
      };
    });
}

function stations() {
  const modules = new Map();
  for (const m of db.prepare('SELECT station_id, factory FROM station_modules ORDER BY factory').all()) {
    if (!modules.has(m.station_id)) modules.set(m.station_id, []);
    modules.get(m.station_id).push(m.factory);
  }
  return db.prepare(`
    SELECT st.id, st.name, st.code, st.system, st.faction_nick, st.faction_name, st.core_level,
           ss.synced_at
    FROM stations st LEFT JOIN station_status ss ON ss.station_id = st.id
    WHERE st.active = 1 ORDER BY st.sort_order, st.name
  `).all().map((s) => ({
    id: s.id, name: s.name, code: s.code, system: s.system,
    factionNick: s.faction_nick, factionName: s.faction_name, level: s.core_level,
    syncedAt: s.synced_at, modules: modules.get(s.id) || [],
  }));
}

/**
 * Stocks par identifiant de marchandise.
 *
 * Les soutes se rattachent aux recettes par le nickname que darkstat donne
 * aux deux. Une fiche créée avant que l'API ne fournisse le sien n'en a
 * pas : on la rattrape par son nom, mais seulement quand ce nom ne désigne
 * qu'un seul identifiant — plusieurs équipements portent le même.
 */
function stocks(noms) {
  const parNom = new Map();
  const ambigus = new Set();
  for (const [nick, n] of Object.entries(noms)) {
    if (n.kind !== 'item') continue;
    const cle = n.name.toLowerCase();
    if (parNom.has(cle)) ambigus.add(cle); else parNom.set(cle, nick);
  }

  const stock = {};
  const items = {};
  const lignes = db.prepare(`
    SELECT i.id AS item_id, i.name, i.commodity_id, v.station_id, v.effective_qty
    FROM v_effective_stock v
    JOIN items i ON i.id = v.item_id
    JOIN stations st ON st.id = v.station_id AND st.active = 1
  `).all();

  for (const l of lignes) {
    const cle = String(l.name || '').toLowerCase();
    const nick = l.commodity_id || (ambigus.has(cle) ? null : parNom.get(cle));
    if (!nick) continue;
    items[nick] = l.item_id;
    (stock[nick] ||= {})[l.station_id] = (stock[nick][l.station_id] || 0) + (Number(l.effective_qty) || 0);
  }
  return { stock, items };
}

function commandes() {
  const ordres = db.prepare(`
    SELECT o.id, o.client, o.note, o.status, o.created_by, o.created_at, o.closed_at,
           COALESCE(u.callsign, u.display_name, u.username) AS author
    FROM production_orders o LEFT JOIN users u ON u.id = o.created_by
    WHERE o.status = 'open'
       OR o.id IN (SELECT id FROM production_orders WHERE status = 'delivered'
                   ORDER BY closed_at DESC LIMIT 15)
    ORDER BY o.created_at, o.id
  `).all();

  const parOrdre = new Map(ordres.map((o) => [o.id, []]));
  for (const l of db.prepare(`
    SELECT id, order_id, recipe_nick, recipe_name, quantity, station_id, status,
           started_at, finished_at
    FROM production_lines ORDER BY id
  `).all()) {
    parOrdre.get(l.order_id)?.push({
      id: l.id, recipe: l.recipe_nick, name: l.recipe_name, quantity: l.quantity,
      stationId: l.station_id, status: l.status, startedAt: l.started_at, finishedAt: l.finished_at,
    });
  }

  return ordres.map((o) => ({
    id: o.id, client: o.client, note: o.note, status: o.status,
    createdBy: o.created_by, author: o.author, createdAt: o.created_at, closedAt: o.closed_at,
    lines: parOrdre.get(o.id),
  }));
}

/** Tout ce que l'écran de l'arsenal affiche, en un appel. */
export function overview(user) {
  const orders = commandes();
  const reclamees = new Set(orders.flatMap((o) => o.lines.map((l) => l.recipe)));

  const names = {};
  for (const n of db.prepare('SELECT nickname, name, kind, volume FROM craft_names').all()) {
    names[n.nickname] = { name: n.name, kind: n.kind, volume: n.volume };
  }

  return {
    recipes: recettes(reclamees),
    names,
    stations: stations(),
    ...stocks(names),
    orders,
    syncedAt: getSetting('recipes_synced_at'),
    now: nowSql(),
    me: { id: user.id, officer: estOfficier(user) },
  };
}

/* ------------------------------------------------------- commandes */

const lireOrdre = (id) => db.prepare('SELECT * FROM production_orders WHERE id = ?').get(id);
const lireLigne = (id) => db.prepare(`
  SELECT l.*, o.created_by AS order_owner, o.status AS order_status
  FROM production_lines l JOIN production_orders o ON o.id = l.order_id WHERE l.id = ?
`).get(id);

/** Une commande se modifie par qui l'a saisie, ou par un officier. */
const peutModifier = (user, proprietaire) => estOfficier(user) || proprietaire === user.id;

function ligneValide(brut) {
  const recette = db.prepare('SELECT nickname, name FROM craft_recipes WHERE nickname = ?')
    .get(String(brut?.recipe ?? ''));
  if (!recette) return echec('Recette inconnue.');

  const quantite = entier(brut?.quantity);
  if (!(quantite >= 1) || quantite > QUANTITE_MAX) return echec('Indiquez une quantité entre 1 et 1 000 000.');

  const station = stationValide(brut?.stationId);
  if (station.error) return station;

  return { ok: true, recette, quantite, stationId: station.id };
}

/** null est admis : la station se choisit au plus tard au lancement. */
function stationValide(valeur) {
  if (valeur == null || valeur === '') return { id: null };
  const s = db.prepare('SELECT id FROM stations WHERE id = ? AND active = 1').get(entier(valeur));
  return s ? { id: s.id } : echec('Station inconnue.');
}

const insererLigne = (ordreId, l) => db.prepare(`
  INSERT INTO production_lines (order_id, recipe_nick, recipe_name, quantity, station_id)
  VALUES (?, ?, ?, ?, ?)
`).run(ordreId, l.recette.nickname, l.recette.name, l.quantite, l.stationId).lastInsertRowid;

export function createOrder(user, { client, note, lines } = {}) {
  const nom = texte(client, 80);
  if (!nom) return echec('Indiquez le nom du client.');
  if (!Array.isArray(lines) || !lines.length) return echec('Ajoutez au moins une fabrication à la commande.');
  if (lines.length > LIGNES_MAX) return echec(`Une commande porte au plus ${LIGNES_MAX} lignes.`);

  const valides = [];
  for (const brut of lines) {
    const l = ligneValide(brut);
    if (!l.ok) return l;
    valides.push(l);
  }

  const id = db.transaction(() => {
    const ordre = db.prepare('INSERT INTO production_orders (client, note, created_by) VALUES (?, ?, ?)')
      .run(nom, texte(note, 400), user.id).lastInsertRowid;
    for (const l of valides) insererLigne(ordre, l);
    return ordre;
  })();

  audit(user.id, 'production.order.created', 'production_orders', id, { client: nom, lines: valides.length });
  return { ok: true, id };
}

export function updateOrder(user, id, { client, note } = {}) {
  const ordre = lireOrdre(id);
  if (!ordre) return echec('Commande inconnue.', 404);
  if (!peutModifier(user, ordre.created_by)) return echec('Cette commande n’est pas la vôtre.', 403);
  const nom = texte(client, 80);
  if (!nom) return echec('Indiquez le nom du client.');
  db.prepare('UPDATE production_orders SET client = ?, note = ? WHERE id = ?').run(nom, texte(note, 400), id);
  return { ok: true };
}

export function deleteOrder(user, id) {
  const ordre = lireOrdre(id);
  if (!ordre) return echec('Commande inconnue.', 404);
  if (!peutModifier(user, ordre.created_by)) return echec('Cette commande n’est pas la vôtre.', 403);
  db.prepare('DELETE FROM production_orders WHERE id = ?').run(id);
  audit(user.id, 'production.order.deleted', 'production_orders', id, { client: ordre.client });
  return { ok: true };
}

/** Remise au client, ou réouverture d'une commande close par erreur. */
export function setOrderDelivered(user, id, delivered) {
  const ordre = lireOrdre(id);
  if (!ordre) return echec('Commande inconnue.', 404);
  if (!peutModifier(user, ordre.created_by)) return echec('Cette commande n’est pas la vôtre.', 403);

  if (delivered) {
    const reste = db.prepare(
      "SELECT COUNT(*) AS n FROM production_lines WHERE order_id = ? AND status <> 'done'").get(id).n;
    if (reste) return echec('Des fabrications ne sont pas terminées : terminez-les ou retirez-les avant de remettre la commande.', 409);
    db.prepare("UPDATE production_orders SET status = 'delivered', closed_at = ? WHERE id = ?").run(nowSql(), id);
  } else {
    db.prepare("UPDATE production_orders SET status = 'open', closed_at = NULL WHERE id = ?").run(id);
  }
  audit(user.id, delivered ? 'production.order.delivered' : 'production.order.reopened',
    'production_orders', id, { client: ordre.client });
  return { ok: true };
}

/* ---------------------------------------------------------- lignes */

export function addLine(user, ordreId, brut) {
  const ordre = lireOrdre(ordreId);
  if (!ordre) return echec('Commande inconnue.', 404);
  if (!peutModifier(user, ordre.created_by)) return echec('Cette commande n’est pas la vôtre.', 403);
  if (ordre.status !== 'open') return echec('Cette commande est close.', 409);
  const n = db.prepare('SELECT COUNT(*) AS n FROM production_lines WHERE order_id = ?').get(ordreId).n;
  if (n >= LIGNES_MAX) return echec(`Une commande porte au plus ${LIGNES_MAX} lignes.`);

  const l = ligneValide(brut);
  if (!l.ok) return l;
  return { ok: true, id: insererLigne(ordreId, l) };
}

function ligneModifiable(user, id) {
  const ligne = lireLigne(id);
  if (!ligne) return echec('Fabrication inconnue.', 404);
  if (!peutModifier(user, ligne.order_owner)) return echec('Cette commande n’est pas la vôtre.', 403);
  if (ligne.order_status !== 'open') return echec('Cette commande est close.', 409);
  return { ok: true, ligne };
}

export function updateLine(user, id, { quantity, stationId } = {}) {
  const acces = ligneModifiable(user, id);
  if (!acces.ok) return acces;
  const { ligne } = acces;
  // Quantité et station décident de ce qui a été prélevé au lancement :
  // on ne les change pas sous une fabrication partie.
  if (ligne.status !== 'queued') return echec('Cette fabrication est déjà lancée : remettez-la en file pour la modifier.', 409);

  let quantite = ligne.quantity;
  if (quantity !== undefined) {
    quantite = entier(quantity);
    if (!(quantite >= 1) || quantite > QUANTITE_MAX) return echec('Indiquez une quantité entre 1 et 1 000 000.');
  }
  let station = { id: ligne.station_id };
  if (stationId !== undefined) {
    station = stationValide(stationId);
    if (station.error) return station;
  }
  db.prepare('UPDATE production_lines SET quantity = ?, station_id = ? WHERE id = ?')
    .run(quantite, station.id, id);
  return { ok: true };
}

export function deleteLine(user, id) {
  const acces = ligneModifiable(user, id);
  if (!acces.ok) return acces;
  db.prepare('DELETE FROM production_lines WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Fait avancer une fabrication : en file → lancée → terminée, ou retour.
 *
 * Le lancement exige une station : c'est elle qui fournit les matériaux,
 * et c'est sur elle que la durée court.
 */
export function setLineStatus(user, id, status, { stationId } = {}) {
  if (!['queued', 'running', 'done'].includes(status)) return echec('État inconnu.');
  const acces = ligneModifiable(user, id);
  if (!acces.ok) return acces;
  const { ligne } = acces;

  if (status === 'running') {
    let station = ligne.station_id;
    if (stationId !== undefined && stationId !== null && stationId !== '') {
      const s = stationValide(stationId);
      if (s.error) return s;
      station = s.id;
    }
    if (!station) return echec('Choisissez la station qui fabrique avant de lancer.');
    db.prepare(`
      UPDATE production_lines
      SET status = 'running', station_id = ?, started_at = ?, finished_at = NULL, started_by = ?
      WHERE id = ?
    `).run(station, nowSql(), user.id, id);
  } else if (status === 'done') {
    db.prepare(`
      UPDATE production_lines
      SET status = 'done', finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?
    `).run(nowSql(), nowSql(), id);
  } else {
    db.prepare(`
      UPDATE production_lines SET status = 'queued', started_at = NULL, finished_at = NULL WHERE id = ?
    `).run(id);
  }

  audit(user.id, `production.line.${status}`, 'production_lines', id, { recipe: ligne.recipe_nick });
  return { ok: true };
}

/* --------------------------------------------------------- modules */

/** Remplace la liste des modules d'une station. Réservé aux officiers. */
export function setStationModules(user, stationId, factories) {
  const station = db.prepare('SELECT id, name FROM stations WHERE id = ?').get(stationId);
  if (!station) return echec('Station inconnue.', 404);
  if (!Array.isArray(factories)) return echec('Liste de modules attendue.');

  // Seuls les noms d'usine que portent les recettes sont admis : un module
  // mal orthographié ne fabriquerait jamais rien.
  const connus = new Set(db.prepare(
    "SELECT DISTINCT factory FROM craft_recipes WHERE factory <> ''").all().map((r) => r.factory));
  const retenus = [...new Set(factories.map((f) => String(f)))].filter((f) => connus.has(f));

  db.transaction(() => {
    db.prepare('DELETE FROM station_modules WHERE station_id = ?').run(stationId);
    const poser = db.prepare('INSERT INTO station_modules (station_id, factory) VALUES (?, ?)');
    for (const f of retenus) poser.run(stationId, f);
  })();

  audit(user.id, 'production.modules.set', 'stations', stationId, { modules: retenus });
  return { ok: true, modules: retenus };
}
