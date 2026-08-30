/* =====================================================================
   Routes automatiques.

   Pour chaque mission ouverte, on cherche dans le marché darkstat la base
   qui vend la marchandise au meilleur prix (import) ou qui l'achète au
   meilleur prix (export), en écartant les factions interdites.

   Le résultat est stocké comme une route « auto », recalculée à chaque
   analyse. Les routes saisies à la main ne sont jamais touchées : elles
   portent une connaissance que l'API n'a pas.
   ===================================================================== */

import { config } from '../config.js';
import { db, nowSql } from '../db/index.js';
import { broadcast } from '../services/events.js';

/* ------------------------------------------------------ lecture souple */

/**
 * Première valeur définie parmi plusieurs noms de champs possibles.
 *
 * darkstat n'expose pas les mêmes clés d'un endpoint à l'autre
 * (`price` / `sell_price`, `nickname` / `commodity`). Plutôt que de figer
 * un schéma supposé, on accepte les variantes connues.
 */
function champ(objet, ...noms) {
  if (!objet) return undefined;
  for (const n of noms) {
    if (objet[n] !== undefined && objet[n] !== null) return objet[n];
  }
  return undefined;
}

const nombre = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Ramène une entrée de marché à une forme unique.
 * Renvoie null si l'entrée n'est pas exploitable.
 */
function normaliserOffre(brut) {
  // Les entrées de market_goods sont plates : pas d'objet « base » imbriqué,
  // les champs de la base portent le préfixe base_. On accepte tout de même
  // la forme imbriquée, utilisée par /api/pob_goods.
  const base = champ(brut, 'base', 'station') || brut;
  const shop = champ(brut, 'shop_item', 'market_good') || brut;

  const nickname = champ(base, 'base_nickname', 'nickname');
  const name = champ(base, 'base_name', 'name');
  if (!name && !nickname) return null;

  // Deux prix, deux sens. « price_base_sells_for » est ce que la base
  // réclame quand elle nous vend ; « price_base_buys_for » ce qu'elle
  // consent à nous payer. Les confondre inversait toute l'analyse.
  const prixAchat = nombre(champ(shop, 'price_base_sells_for', 'price', 'price_to_buy'));
  const prixVente = nombre(champ(shop, 'price_base_buys_for', 'sell_price', 'price_to_sell'));

  // Un prix affiché ne vaut rien si la base ne fait pas l'opération.
  const vend = champ(shop, 'base_sells', 'is_selling');
  const achete = champ(shop, 'base_buys', 'is_buying');

  return {
    baseNickname: nickname ? String(nickname) : null,
    baseName: name ? String(name) : String(nickname),
    faction: champ(base, 'faction_name', 'faction') ?? null,
    system: champ(base, 'system_name', 'system') ?? null,
    secteur: champ(base, 'sector_coord', 'sector') ?? null,
    region: champ(base, 'region_name') ?? null,
    estPob: Boolean(champ(base, 'PoB', 'IsPob', 'is_pob')),

    prixAchat,
    prixVente,
    quantite: nombre(champ(shop, 'quantity', 'stock')) ?? 0,
    vend: vend === undefined ? null : Boolean(vend),
    achete: achete === undefined ? null : Boolean(achete),
  };
}

/**
 * Indexe le marché par identifiant de marchandise.
 *
 * Accepte deux formes : une liste de marchandises portant chacune ses
 * bases, ou une liste plate d'offres portant chacune sa marchandise.
 */
export function indexerMarche(payload) {
  const index = new Map();
  const lignes = Array.isArray(payload) ? payload : (payload?.items || []);

  for (const entree of lignes) {
    const cle = champ(entree, 'nickname', 'commodity_nickname', 'commodity');
    const bases = champ(entree, 'market_goods', 'bases', 'markets', 'sold_at');

    if (cle && Array.isArray(bases)) {
      const offres = bases.map(normaliserOffre).filter(Boolean);
      if (offres.length) index.set(String(cle), offres);
      continue;
    }

    // Forme observée sur /api/commodities : les meilleurs prix sont donnés
    // directement, mais « market_goods » est nul — donc aucune base nommée.
    // L'information économique reste utile même sans destination.
    const achat = nombre(champ(entree, 'price_best_base_sells_for'));
    const vente = nombre(champ(entree, 'price_best_base_buys_for'));
    if (cle && (achat != null || vente != null) && !Array.isArray(bases)) {
      if (!index.has(String(cle))) index.set(String(cle), []);
      index.get(String(cle)).push({
        baseNickname: null,
        baseName: null,
        faction: null, system: null, secteur: null,
        prixAchat: achat, prixVente: vente,
        marge: nombre(champ(entree, 'proffit_margin')),
        quantite: 1,
        agrege: true,
      });
      continue;
    }

    // Forme plate : une offre par ligne.
    const offre = normaliserOffre(entree);
    if (cle && offre) {
      if (!index.has(String(cle))) index.set(String(cle), []);
      index.get(String(cle)).push(offre);
    }
  }
  return index;
}

/* ------------------------------------------------------------ récupération */

/**
 * Interroge le marché.
 *
 * `/api/commodities` est un POST : sans « include_market_goods », la
 * réponse ne porte que les meilleurs prix, sans nom de base. On restreint
 * aussi la demande aux marchandises réellement utiles — le jeu en compte
 * plusieurs centaines, et la charge utile grossit vite avec les marchés.
 */
async function lireMarche(nicknames) {
  const index = new Map();

  const fusionner = (payload) => {
    for (const [cle, offres] of indexerMarche(payload)) {
      if (!index.has(cle)) index.set(cle, []);
      index.get(cle).push(...offres);
    }
  };

  const appeler = async (chemin, options) => {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), config.darkstat.timeoutMs ?? 20000);
    try {
      const res = await fetch(`${config.darkstat.baseUrl}${chemin}`, { ...options, signal: ctrl.signal });
      if (!res.ok) {
        // Un corps mal formé renvoie 400 : sans cette trace, l'analyse
        // semblait simplement ne rien trouver.
        const detail = await res.text().catch(() => '');
        console.warn(`[routes] ${chemin} a répondu ${res.status} ${detail.slice(0, 120)}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`[routes] ${chemin} injoignable : ${err.message}`);
      return null;
    } finally {
      clearTimeout(minuteur);
    }
  };

  const commodities = await appeler('/api/commodities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Types imposés par le schéma GetCommoditiesInput : deux booléens et
    // un tableau de chaînes. Envoyer « "true" » au lieu de « true » fait
    // échouer le décodage du corps côté darkstat.
    body: JSON.stringify({
      include_market_goods: true,
      filter_to_useful: false,
      ...(nicknames?.length ? { filter_nicknames: nicknames.map(String) } : {}),
    }),
  });
  if (commodities) fusionner(commodities);

  const pob = await appeler('/api/pob_goods', { method: 'GET' });
  if (pob) fusionner(pob);

  return index;
}

/* --------------------------------------------------------------- calcul */

/** Meilleure offre pour un sens donné, hors factions interdites. */
export function meilleureOffre(offres, direction, interdites, exclure = null) {
  const aEviter = exclure ? String(exclure).toLowerCase() : null;

  const utiles = (offres || []).filter((o) => {
    // Seule la station de destination est écartée : une route vers
    // elle-même n'a pas de sens. Nos autres stations restent des sources
    // et des débouchés légitimes — c'est même tout l'intérêt du réseau.
    if (aEviter && o.baseNickname && String(o.baseNickname).toLowerCase() === aEviter) return false;
    if (o.faction && interdites.has(String(o.faction).toLowerCase())) return false;
    // « base_sells » à false signifie que la base n'écoule pas cette
    // marchandise : son prix affiché est théorique et ne sert à rien.
    if (direction === 'import') {
      if (o.vend === false) return false;
      return o.prixAchat != null && o.prixAchat > 0;
    }
    if (o.achete === false) return false;
    return o.prixVente != null && o.prixVente > 0;
  });

  if (!utiles.length) return null;

  // Import : on veut acheter au moins cher. Export : vendre au plus cher.
  // À prix comparable, une offre localisée vaut mieux qu'un prix agrégé
  // sans nom de base : le pilote a besoin d'une destination.
  utiles.sort((a, b) => {
    const parPrix = direction === 'import'
      ? a.prixAchat - b.prixAchat
      : b.prixVente - a.prixVente;
    if (parPrix !== 0) return parPrix;
    return (a.agrege ? 1 : 0) - (b.agrege ? 1 : 0);
  });

  return utiles[0];
}

export const analyserRoutes = async () => {
  const marche = await lireMarche();
  if (!marche.size) {
    return { ok: false, error: 'Aucune donnée de marché exploitable.' };
  }

  // Nom API de chaque station, pour écarter la route vers soi-même.
  const nomApi = new Map(
    db.prepare('SELECT id, api_name FROM stations').all().map((r) => [r.id, r.api_name])
  );

  const interdites = new Set(
    db.prepare('SELECT faction_name FROM blocked_factions').all()
      .map((r) => String(r.faction_name).toLowerCase())
  );

  // On ne calcule que ce qui sert : les marchandises réellement demandées.
  const besoins = db.prepare(`
    SELECT DISTINCT m.item_id, m.station_id, m.direction, i.commodity_id, i.name
    FROM missions m
    JOIN items i ON i.id = m.item_id
    WHERE m.status = 'open' AND i.commodity_id IS NOT NULL
  `).all();

  const stamp = nowSql();
  const poser = db.prepare(`
    INSERT INTO routes
      (item_id, dest_id, direction, source_label, base_nickname, faction_name,
       system_name, sector_coord, price, margin, auto, priority, computed_at)
    VALUES
      (@item_id, @dest_id, @direction, @source_label, @base_nickname, @faction_name,
       @system_name, @sector_coord, @price, @margin, 1, 0, @computed_at)
    ON CONFLICT(item_id, dest_id, direction, base_nickname) WHERE auto = 1
      DO UPDATE SET
        source_label = excluded.source_label,
        faction_name = excluded.faction_name,
        system_name  = excluded.system_name,
        sector_coord = excluded.sector_coord,
        price        = excluded.price,
        margin       = excluded.margin,
        computed_at  = excluded.computed_at
  `);

  let trouvees = 0;
  const appliquer = db.transaction(() => {
    // Les routes calculées obsolètes disparaissent ; les manuelles restent.
    db.prepare(`DELETE FROM routes WHERE auto = 1`).run();

    for (const b of besoins) {
      const offre = meilleureOffre(
        marche.get(b.commodity_id), b.direction, interdites, nomApi.get(b.station_id));
      if (!offre) continue;

      poser.run({
        item_id: b.item_id,
        dest_id: b.station_id,
        direction: b.direction,
        source_label: offre.baseName,   // null si le prix vient d'un agrégat
        base_nickname: offre.baseNickname,
        faction_name: offre.faction,
        system_name: offre.system,
        sector_coord: offre.secteur,
        price: b.direction === 'import' ? offre.prixAchat : offre.prixVente,
        margin: offre.marge ?? null,
        computed_at: stamp,
      });
      trouvees++;
    }
  });
  appliquer();

  broadcast('routes:changed', { count: trouvees });
  return { ok: true, analysees: besoins.length, trouvees, ecartees: interdites.size };
};


/* ------------------------------------------------------- planification */

let minuteur = null;

/**
 * Analyse périodique des routes.
 *
 * Volontairement découplée du relevé des stocks : les prix bougent à
 * l'échelle de l'heure, pas du quart d'heure. Le premier passage est
 * différé de deux minutes pour laisser un relevé de stock arriver — sans
 * missions ouvertes, l'analyse n'aurait rien à chercher.
 */
export function startRoutesWorker() {
  const every = config.darkstat.routesIntervalMs;
  if (!every || every < 60_000) return;

  const passe = async () => {
    try {
      const r = await analyserRoutes();
      if (r.ok) console.log(`[routes] ${r.trouvees}/${r.analysees} route(s) suggérée(s)`);
      else console.warn(`[routes] ${r.error}`);
    } catch (err) {
      console.warn(`[routes] échec : ${err.message}`);
    }
  };

  setTimeout(passe, 120_000);
  minuteur = setInterval(passe, every);
  console.log(`[routes] analyse toutes les ${Math.round(every / 60000)} min`);
}

export function stopRoutesWorker() {
  if (minuteur) clearInterval(minuteur);
  minuteur = null;
}
