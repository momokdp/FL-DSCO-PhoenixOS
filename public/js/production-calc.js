/* =====================================================================
   Arsenal — calcul des besoins.

   Fonctions pures, sans DOM : ce qu'une fabrication réclame, ce que les
   soutes en couvrent, ce qu'il reste à importer. Elles tournent dans le
   navigateur pour répondre à chaque chiffre tapé dans un brouillon de
   commande, et se laissent éprouver seules sous Node.

   Vocabulaire :
     lot       une exécution de la recette (un « /craft »)
     sur place ce que porte la station qui fabrique
     ailleurs  ce que portent nos autres stations — à transférer
     manquant  ce qu'aucune de nos stations ne porte — à importer
   ===================================================================== */

/** Une quantité multipliée par un bonus se paie à l'unité supérieure. */
const plafond = (v) => Math.ceil(v - 1e-9);

const dateSql = (s) => Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');

/** Produit principal, tel que cette station le sort. */
export function productFor(recipe, station = null) {
  const p = recipe.produced[0];
  if (!p) return { nick: recipe.product, qty: 1 };
  const propre = station && (p.byFaction || []).find((f) => f.faction === station.factionNick);
  return propre ? { nick: propre.nick, qty: propre.qty } : { nick: p.nick, qty: p.qty };
}

/** Nombre de lots pour obtenir `quantity` unités du produit principal. */
export function runsFor(recipe, quantity, station = null) {
  const parLot = Math.max(1, productFor(recipe, station).qty);
  return Math.max(1, Math.ceil(quantity / parLot));
}

/** Bonus de matériaux que l'affiliation de la station obtient, 1 sinon. */
export function multiplierFor(recipe, station = null) {
  if (!station?.factionNick) return 1;
  const b = recipe.bonuses.find((x) => x.faction === station.factionNick);
  return b ? b.mult : 1;
}

/**
 * Ce qui empêche cette station de lancer cette recette.
 * Liste vide : rien ne s'y oppose.
 *
 * Tant qu'aucun module n'a été déclaré sur une station, on ne lui reproche
 * pas d'en manquer : l'officier n'a simplement pas encore renseigné
 * l'écran des modules, et tout marquer « impossible » ne dirait rien.
 */
export function obstacles(recipe, station) {
  const out = [];
  if (!station) return out;
  if (recipe.factory && station.modules.length && !station.modules.includes(recipe.factory)) out.push('module');
  if (recipe.level > 0 && station.level != null && station.level < recipe.level) out.push('level');
  if (recipe.restricted && station.factionNick &&
      !recipe.bonuses.some((b) => b.faction === station.factionNick)) out.push('restricted');
  return out;
}

/** Stations sans obstacle, celles qui déclarent le module en tête. */
export function stationsFor(recipe, stations) {
  return stations
    .filter((s) => !obstacles(recipe, s).length)
    .sort((a, b) => Number(b.modules.includes(recipe.factory)) - Number(a.modules.includes(recipe.factory)));
}

const stockDe = (pool, nick, stationId) => pool[nick]?.[stationId] || 0;
const stockTotal = (pool, nick) => Object.values(pool[nick] || {}).reduce((a, b) => a + b, 0);

/**
 * Parmi des marchandises qui se valent, celle que les soutes couvrent le
 * mieux : d'abord sur place, puis toutes stations confondues.
 */
function meilleureOption(options, runs, mult, pool, stationId) {
  let choix = null;
  for (const o of options) {
    const besoin = plafond(o.qty * runs * mult);
    const surPlace = stationId ? Math.min(1, stockDe(pool, o.nick, stationId) / besoin) : 0;
    const partout = Math.min(1, stockTotal(pool, o.nick) / besoin);
    const note = surPlace * 2 + partout;
    if (!choix || note > choix.note) choix = { nick: o.nick, need: besoin, note };
  }
  return choix;
}

/**
 * Besoins bruts d'une fabrication : ingrédients consommés (alternatives
 * tranchées) et catalyseurs. Le bonus d'affiliation réduit les ingrédients,
 * pas les catalyseurs — ils ne sont pas consommés, seulement présents.
 */
export function requirements(recipe, runs, station, pool) {
  const mult = multiplierFor(recipe, station);
  const stationId = station?.id ?? null;

  const consumed = recipe.consumed.map((c) => ({ nick: c.nick, need: plafond(c.qty * runs * mult) }));
  for (const choix of recipe.choices) {
    const pris = meilleureOption(choix.options, runs, mult, pool, stationId);
    if (!pris) continue;
    consumed.push({
      nick: pris.nick, need: pris.need,
      options: choix.options.map((o) => ({ nick: o.nick, need: plafond(o.qty * runs * mult) })),
    });
  }

  // Une même marchandise peut figurer deux fois (fixe et en alternative).
  const fusion = new Map();
  for (const c of consumed) {
    const deja = fusion.get(c.nick);
    if (deja) { deja.need += c.need; deja.options ||= c.options; } else fusion.set(c.nick, { ...c });
  }

  return {
    mult,
    consumed: [...fusion.values()],
    catalysts: recipe.catalysts.map((c) => ({ nick: c.nick, need: c.qty })),
  };
}

/** Prélève `need` dans la réserve : sur place d'abord, puis ailleurs. */
function prelever(pool, nick, need, stationId) {
  const parStation = pool[nick] || {};
  let reste = need;

  let onSite = 0;
  if (stationId != null) {
    onSite = Math.min(reste, parStation[stationId] || 0);
    if (onSite) parStation[stationId] -= onSite;
    reste -= onSite;
  }

  let elsewhere = 0;
  const from = [];
  for (const [id, qty] of Object.entries(parStation)) {
    if (reste <= 0) break;
    if (String(id) === String(stationId) || qty <= 0) continue;
    const pris = Math.min(reste, qty);
    parStation[id] -= pris;
    elsewhere += pris;
    reste -= pris;
    from.push({ stationId: Number(id), qty: pris });
  }

  return { onSite, elsewhere, missing: reste, from };
}

/**
 * Combien de lots la station peut lancer tout de suite, avec ce qu'elle
 * porte. Sert au catalogue : « de quoi en faire 3 à KOC ».
 */
export function capacity(recipe, station, pool) {
  if (obstacles(recipe, station).length) return 0;
  const mult = multiplierFor(recipe, station);
  let lots = Infinity;
  for (const c of recipe.consumed) {
    lots = Math.min(lots, Math.floor(stockDe(pool, c.nick, station.id) / plafond(c.qty * mult)));
  }
  for (const choix of recipe.choices) {
    lots = Math.min(lots, Math.max(0, ...choix.options.map((o) =>
      Math.floor(stockDe(pool, o.nick, station.id) / plafond(o.qty * mult)))));
  }
  for (const c of recipe.catalysts) {
    if (stockDe(pool, c.nick, station.id) < c.qty) return 0;
  }
  return Number.isFinite(lots) ? lots : 0;
}

/**
 * Déroule la file de production contre les soutes.
 *
 * Les commandes se servent dans l'ordre où elles ont été saisies : la plus
 * ancienne prend ce qu'il lui faut, la suivante ce qui reste. Une
 * fabrication lancée ne réclame plus rien — la station a déjà prélevé ses
 * matériaux, et le relevé suivant le montre dans les stocks.
 *
 * @param data  réponse de /api/production, ou un sous-ensemble équivalent
 * @param draft lignes d'un brouillon à simuler en fin de file (facultatif)
 */
export function plan(data, draft = null) {
  const recettes = new Map(data.recipes.map((r) => [r.nick, r]));
  const stations = new Map(data.stations.map((s) => [s.id, s]));
  const pool = {};
  for (const [nick, parStation] of Object.entries(data.stock || {})) pool[nick] = { ...parStation };

  const maintenant = data.now ? dateSql(data.now) : Date.now();
  const lignes = [];

  const derouler = (ordre, l) => {
    const recipe = recettes.get(l.recipe) || null;
    // Sans station désignée, on raisonne sur la première qui convient :
    // c'est là que la fabrication ira, sauf décision contraire.
    const voulue = l.stationId != null ? stations.get(Number(l.stationId)) || null : null;
    const station = voulue || (recipe ? stationsFor(recipe, data.stations)[0] || null : null);

    const out = {
      line: l, order: ordre, recipe, station, assigned: !!voulue,
      runs: 0, product: null, mult: 1, minutes: 0,
      consumed: [], catalysts: [], issues: [], state: l.status,
    };
    if (!recipe) { out.issues.push('unknown'); out.state = l.status === 'queued' ? 'blocked' : l.status; return out; }

    out.runs = runsFor(recipe, l.quantity, station);
    out.product = productFor(recipe, station);
    out.minutes = recipe.minutes * out.runs;

    if (l.status === 'running') {
      const debut = l.startedAt ? dateSql(l.startedAt) : maintenant;
      const duree = out.minutes * 60_000;
      out.progress = duree > 0 ? Math.min(1, Math.max(0, (maintenant - debut) / duree)) : 1;
      out.endsAt = debut + duree;
      out.remainingMinutes = Math.max(0, (out.endsAt - maintenant) / 60_000);
      return out;
    }
    if (l.status === 'done') return out;

    // Aucune station ne convient : module, niveau ou affiliation, la
    // recette ne se lance nulle part chez nous.
    out.issues = station ? obstacles(recipe, station) : (data.stations.length ? ['nowhere'] : []);
    const besoins = requirements(recipe, out.runs, station, pool);
    out.mult = besoins.mult;

    for (const c of besoins.consumed) {
      out.consumed.push({ ...c, ...prelever(pool, c.nick, c.need, station?.id ?? null) });
    }
    // Les catalyseurs ne se prélèvent pas : ils doivent seulement être là.
    for (const c of besoins.catalysts) {
      const have = station ? stockDe(data.stock || {}, c.nick, station.id) : 0;
      const autres = stockTotal(data.stock || {}, c.nick) - have;
      const manque = Math.max(0, c.need - have);
      out.catalysts.push({
        ...c, onSite: Math.min(c.need, have),
        elsewhere: Math.min(manque, autres), missing: Math.max(0, manque - autres),
      });
    }

    const tout = [...out.consumed, ...out.catalysts];
    out.state = out.issues.length ? 'blocked'
      : tout.some((c) => c.missing > 0) ? 'short'
        : tout.some((c) => c.elsewhere > 0) ? 'transfer' : 'ready';
    return out;
  };

  for (const ordre of data.orders || []) {
    if (ordre.status !== 'open') continue;
    for (const l of ordre.lines) lignes.push(derouler(ordre, l));
  }
  const brouillon = (draft || []).map((l) => derouler(null, { status: 'queued', ...l }));

  return { lines: lignes, draft: brouillon, shopping: shopping([...lignes, ...brouillon]) };
}

/**
 * Liste de courses : par station et par marchandise, ce que les
 * fabrications en file réclament et ce qu'il faut encore faire venir.
 * Les catalyseurs s'additionnent au maximum, pas à la somme — deux
 * fabrications sur la même station partagent le même équipage.
 */
export function shopping(lignes) {
  const map = new Map();
  for (const l of lignes) {
    if (l.line.status !== 'queued' || !l.recipe) continue;
    const stationId = l.station?.id ?? null;
    const poser = (c, catalyst) => {
      const cle = `${stationId}\u0000${c.nick}\u0000${catalyst ? 1 : 0}`;
      let e = map.get(cle);
      if (!e) map.set(cle, e = { stationId, nick: c.nick, catalyst, need: 0, onSite: 0, elsewhere: 0, missing: 0, orders: new Set() });
      if (catalyst) {
        if (c.need > e.need) Object.assign(e, { need: c.need, onSite: c.onSite, elsewhere: c.elsewhere, missing: c.missing });
      } else {
        e.need += c.need; e.onSite += c.onSite; e.elsewhere += c.elsewhere; e.missing += c.missing;
      }
      if (l.order) e.orders.add(l.order.client);
    };
    l.consumed.forEach((c) => poser(c, false));
    l.catalysts.forEach((c) => poser(c, true));
  }
  return [...map.values()].map((e) => ({ ...e, orders: [...e.orders] }));
}

/** État d'ensemble d'une commande, d'après ses lignes déroulées. */
export function orderState(lignes) {
  if (!lignes.length) return 'empty';
  if (lignes.every((l) => l.line.status === 'done')) return 'done';
  const enFile = lignes.filter((l) => l.line.status === 'queued');
  if (enFile.some((l) => l.state === 'blocked')) return 'blocked';
  if (enFile.some((l) => l.state === 'short')) return 'short';
  if (enFile.some((l) => l.state === 'transfer')) return 'transfer';
  if (enFile.length) return 'ready';
  return 'running';
}
