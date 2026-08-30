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
  const base = champ(brut, 'base', 'station') || brut;

  const nickname = champ(base, 'nickname', 'base_nickname');
  const name = champ(base, 'name', 'base_name');
  if (!name && !nickname) return null;

  const shop = champ(brut, 'shop_item', 'market_good') || brut;

  return {
    baseNickname: nickname ? String(nickname) : null,
    baseName: name ? String(name) : String(nickname),
    faction: champ(base, 'faction_name', 'faction') ?? null,
    system: champ(base, 'system_name', 'system') ?? null,
    secteur: champ(base, 'sector_coord', 'sector') ?? null,
    estPob: Boolean(champ(base, 'IsPob', 'is_pob')),

    // Prix auquel la base VEND au joueur, puis auquel elle lui ACHÈTE.
    prixAchat: nombre(champ(shop, 'price', 'price_to_buy', 'buy_price')),
    prixVente: nombre(champ(shop, 'sell_price', 'price_to_sell')),
    quantite: nombre(champ(shop, 'quantity', 'stock')) ?? 0,

    vend: champ(shop, 'is_selling', 'any_base_sells') ?? null,
    achete: champ(shop, 'is_buying', 'any_base_buys') ?? null,
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
    const bases = champ(entree, 'bases', 'markets', 'sold_at');

    if (cle && Array.isArray(bases)) {
      const offres = bases.map(normaliserOffre).filter(Boolean);
      if (offres.length) index.set(String(cle), offres);
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

async function lireMarche() {
  const cibles = ['/api/commodities', '/api/pob_goods'];
  const index = new Map();

  for (const chemin of cibles) {
    try {
      const ctrl = new AbortController();
      const minuteur = setTimeout(() => ctrl.abort(), config.sync.timeoutMs ?? 20000);
      const res = await fetch(`${config.darkstat.url}${chemin}`, { signal: ctrl.signal });
      clearTimeout(minuteur);
      if (!res.ok) continue;

      for (const [cle, offres] of indexerMarche(await res.json())) {
        if (!index.has(cle)) index.set(cle, []);
        index.get(cle).push(...offres);
      }
    } catch {
      // Un endpoint indisponible ne doit pas empêcher l'autre de servir.
    }
  }
  return index;
}

/* --------------------------------------------------------------- calcul */

/** Meilleure offre pour un sens donné, hors factions interdites. */
export function meilleureOffre(offres, direction, interdites) {
  const utiles = (offres || []).filter((o) => {
    if (o.estPob) return false;                      // nos propres bases
    if (o.faction && interdites.has(String(o.faction).toLowerCase())) return false;
    return direction === 'import'
      ? o.prixAchat != null && o.prixAchat > 0 && o.quantite > 0
      : o.prixVente != null && o.prixVente > 0;
  });

  if (!utiles.length) return null;

  // Import : on veut acheter au moins cher. Export : vendre au plus cher.
  utiles.sort((a, b) => direction === 'import'
    ? a.prixAchat - b.prixAchat
    : b.prixVente - a.prixVente);

  return utiles[0];
}

export const analyserRoutes = async () => {
  const marche = await lireMarche();
  if (!marche.size) {
    return { ok: false, error: 'Aucune donnée de marché exploitable.' };
  }

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
       system_name, sector_coord, price, auto, priority, computed_at)
    VALUES
      (@item_id, @dest_id, @direction, @source_label, @base_nickname, @faction_name,
       @system_name, @sector_coord, @price, 1, 0, @computed_at)
    ON CONFLICT(item_id, dest_id, direction, base_nickname) WHERE auto = 1
      DO UPDATE SET
        source_label = excluded.source_label,
        faction_name = excluded.faction_name,
        system_name  = excluded.system_name,
        sector_coord = excluded.sector_coord,
        price        = excluded.price,
        computed_at  = excluded.computed_at
  `);

  let trouvees = 0;
  const appliquer = db.transaction(() => {
    // Les routes calculées obsolètes disparaissent ; les manuelles restent.
    db.prepare(`DELETE FROM routes WHERE auto = 1`).run();

    for (const b of besoins) {
      const offre = meilleureOffre(marche.get(b.commodity_id), b.direction, interdites);
      if (!offre) continue;

      poser.run({
        item_id: b.item_id,
        dest_id: b.station_id,
        direction: b.direction,
        source_label: offre.baseName,
        base_nickname: offre.baseNickname,
        faction_name: offre.faction,
        system_name: offre.system,
        sector_coord: offre.secteur,
        price: b.direction === 'import' ? offre.prixAchat : offre.prixVente,
        computed_at: stamp,
      });
      trouvees++;
    }
  });
  appliquer();

  broadcast('routes:changed', { count: trouvees });
  return { ok: true, analysees: besoins.length, trouvees, ecartees: interdites.size };
};
