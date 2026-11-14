/* =====================================================================
   Recettes de fabrication.

   darkstat ne sert pas les recettes par un point d'entrée à elles. Elles
   se lisent en deux temps :

     1. La base fictive « crafts » de /api/npc_bases porte, comme
        marchandises, tout ce qui se fabrique sur une base joueur — avec
        l'usine, la commande et la durée, mais sans les ingrédients.
     2. L'infocard de chacun de ces objets (/api/infocards, un seul appel
        pour tous) recopie la recette d'origine du serveur, ligne à ligne,
        ingrédients compris.

   Deux appels, 2,3 Mo en tout, pour 263 recettes. Elles ne changent
   qu'aux mises à jour du jeu : un relevé par jour suffit.
   ===================================================================== */

import { config } from '../config.js';
import { db, nowSql, getSetting, setSetting } from '../db/index.js';
import { broadcast } from '../services/events.js';

const CLE_DERNIER_RELEVE = 'recipes_synced_at';
const BASE_FICTIVE = 'crafts';

// En deçà, la réponse n'est pas le catalogue : un relevé tronqué ferait
// passer presque toutes les recettes pour retirées du jeu.
const MINIMUM_VRAISEMBLABLE = 50;

let minuteur = null;
let enCours = false;

async function appeler(chemin, corps = null) {
  const ctrl = new AbortController();
  // Les infocards pèsent deux mégaoctets : le triple du délai ordinaire.
  const delai = config.darkstat.timeoutMs * 3;
  const timeout = setTimeout(() => ctrl.abort(), delai);

  try {
    const res = await fetch(config.darkstat.baseUrl + chemin, {
      method: corps ? 'POST' : 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json', 'User-Agent': 'KadeshConsole/1.0',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    if (!res.ok) throw new Error(`darkstat a répondu HTTP ${res.status} sur ${chemin}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`darkstat n’a pas répondu en ${delai} ms sur ${chemin}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------- lecture */

const nombre = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : 0; };
const liste = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Une infocard est un tableau de lignes, chacune découpée en fragments. */
function lignesDe(infocard) {
  return (infocard || []).map((l) =>
    (l?.phrases || []).map((p) => p?.phrase ?? '').join('').replace(/\r/g, '').trim());
}

/**
 * Extrait les recettes d'une infocard.
 *
 * Chaque recette y figure deux fois : un bloc « translated », lisible, puis
 * le bloc d'origine du serveur. Seul le second est fiable pour les
 * identifiants ; le premier donne ce que l'original ne dit pas — le nom de
 * l'usine, et les noms lisibles des factions et des marchandises.
 */
export function recettesDepuisInfocard(infocard) {
  const recettes = [];
  let traduit = null;   // lignes du bloc lisible en cours
  let brut = null;      // lignes du bloc d'origine en cours

  const clore = () => {
    if (brut) {
      const r = recetteDepuis(brut.lignes, brut.traduit || []);
      if (r) recettes.push(r);
    }
    brut = null;
  };

  for (const ligne of lignesDe(infocard)) {
    if (/^\[RECIPE #\d+\] \(translated\)/.test(ligne)) { clore(); traduit = []; continue; }
    if (/^\[recipe\]/i.test(ligne)) { clore(); brut = { lignes: [], traduit }; traduit = null; continue; }
    if (brut) {
      if (ligne === '' || /^CRAFTING RECIPES FINISHED/.test(ligne)) clore();
      else brut.lignes.push(ligne);
    } else if (traduit) {
      traduit.push(ligne);
    }
  }
  clore();
  return recettes;
}

function recetteDepuis(lignes, traduit) {
  const r = {
    nickname: null, infotext: null, craft_type: null, shortcut: null,
    cooking_rate: 0, req_level: 0, loops: 0, restricted: 0,
    produced: [], consumed: [], choices: [], catalysts: [], bonuses: [],
  };

  for (const ligne of lignes) {
    // « ;craft_type = Survey » : une ligne commentée par le serveur.
    if (ligne.startsWith(';')) continue;
    const m = ligne.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, cle, valeur] = m;
    const v = liste(valeur);

    switch (cle) {
      case 'nickname': r.nickname = v[0] || null; break;
      case 'infotext': r.infotext = valeur.trim(); break;
      case 'craft_type': r.craft_type = v[0] || null; break;
      case 'shortcut_number': r.shortcut = nombre(v[0]); break;
      case 'cooking_rate': r.cooking_rate = nombre(v[0]); break;
      case 'reqlevel': r.req_level = nombre(v[0]); break;
      case 'loop_production': r.loops = nombre(v[0]) ? 1 : 0; break;
      case 'restricted': r.restricted = /^(true|1)$/i.test(v[0] || '') ? 1 : 0; break;
      case 'produced_item':
        if (v[0]) r.produced.push({ nick: v[0], qty: nombre(v[1]) || 1 });
        break;
      case 'produced_affiliation': {
        // produit par défaut, quantité, puis des triplets faction/produit/quantité.
        if (!v[0]) break;
        const p = { nick: v[0], qty: nombre(v[1]) || 1, byFaction: [] };
        for (let i = 2; i + 2 < v.length; i += 3) {
          p.byFaction.push({ faction: v[i], nick: v[i + 1], qty: nombre(v[i + 2]) || 1 });
        }
        r.produced.push(p);
        break;
      }
      case 'consumed':
        if (v[0] && nombre(v[1]) > 0) r.consumed.push({ nick: v[0], qty: nombre(v[1]) });
        break;
      case 'consumed_dynamic_alt': {
        // une quantité, puis les marchandises qui se valent.
        const qty = nombre(v[0]);
        const options = v.slice(1).map((nick) => ({ nick, qty }));
        if (qty > 0 && options.length) r.choices.push({ options });
        break;
      }
      case 'consumed_dynamic': {
        // des couples marchandise/quantité : chacune a son propre tarif.
        const options = [];
        for (let i = 0; i + 1 < v.length; i += 2) {
          if (nombre(v[i + 1]) > 0) options.push({ nick: v[i], qty: nombre(v[i + 1]) });
        }
        if (options.length) r.choices.push({ options });
        break;
      }
      case 'catalyst':
        if (v[0] && nombre(v[1]) > 0) r.catalysts.push({ nick: v[0], qty: nombre(v[1]) });
        break;
      case 'affiliation_bonus':
        if (v[0]) r.bonuses.push({ faction: v[0], mult: nombre(v[1]) || 1 });
        break;
      default: break;
    }
  }

  if (!r.nickname || !r.produced.length) return null;

  // Ce que seul le bloc lisible sait dire.
  const lire = (re) => { for (const l of traduit) { const m = l.match(re); if (m) return m[1].trim(); } return null; };
  r.factory = lire(/^Factory:\s*(.*)$/) || '';
  r.command = lire(/^command:\s*(.*)$/);
  r.total_volume = nombre(lire(/^Total recipe volume:\s*([\d.]+)/));
  const minutesLues = nombre(lire(/^Total recipe time:\s*([\d.]+)\s*minutes/));
  r.minutes = r.cooking_rate > 0 && r.total_volume > 0
    ? Math.round((r.total_volume / r.cooking_rate) * 10) / 10
    : minutesLues;

  // Noms lisibles, appariés dans l'ordre aux lignes d'origine. L'appariement
  // ne vaut que si les deux blocs comptent autant de lignes : sinon on
  // préfère n'avoir aucun nom qu'un nom décalé d'un rang.
  r.noms = {};
  const apparier = (re, cibles, kind) => {
    const lus = traduit.map((l) => l.match(re)).filter(Boolean).map((m) => m[1].trim());
    if (lus.length !== cibles.length) return;
    cibles.forEach((nick, i) => { if (lus[i]) r.noms[nick] = { name: lus[i], kind }; });
  };
  apparier(/^\] consumed:\s*(.+?)\s*\(\d+ amount/, r.consumed.map((c) => c.nick), 'item');
  apparier(/^\* catalyst:\s*(.+?)\s*\(\d+ amount/, r.catalysts.map((c) => c.nick), 'item');
  apparier(/^# ---\s*(.+?)\s*\([\d.]+ multiplier\)/, r.bonuses.map((b) => b.faction), 'faction');

  return r;
}

/* ------------------------------------------------------------ écriture */

/**
 * Écrit le catalogue. Séparée du réseau pour pouvoir être éprouvée seule.
 *
 * @param objets      marchandises de la base fictive « crafts »
 * @param infocards   une infocard par objet, dans le même ordre
 * @param marchandises réponse GET de /api/commodities (noms et volumes)
 */
export function ecrireRecettes(objets, infocards, marchandises = [], stamp = nowSql()) {
  const noms = new Map();      // nickname → { name, kind, volume }
  const categories = new Map();
  const poser = (nick, name, kind = 'item', volume = null, force = false) => {
    if (!nick || !name) return;
    const deja = noms.get(nick);
    if (deja && !force) { if (deja.volume == null && volume != null) deja.volume = volume; return; }
    noms.set(nick, { name, kind, volume: volume ?? deja?.volume ?? null });
  };

  // Le volume de référence est la ligne sans classe de vaisseau.
  for (const c of marchandises) {
    if (c?.ship_class != null) continue;
    const v = Number(c.volume);
    poser(String(c.nickname || '').trim(), String(c.name || '').trim(), 'item',
      Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) / 1e6 : null);
  }
  for (const o of objets) {
    const nick = String(o?.nickname || '').trim();
    poser(nick, String(o?.name || '').trim());
    if (nick && o?.category) categories.set(nick, String(o.category));
  }

  // Une recette figure dans l'infocard de chacun de ses produits : on ne la
  // garde qu'une fois.
  const recettes = new Map();
  for (const carte of infocards) {
    for (const r of recettesDepuisInfocard(carte?.infocard)) {
      if (!recettes.has(r.nickname)) recettes.set(r.nickname, r);
      for (const [nick, n] of Object.entries(r.noms)) poser(nick, n.name, n.kind);
    }
  }

  if (recettes.size < MINIMUM_VRAISEMBLABLE) {
    throw new Error(`Catalogue trop court pour être vrai : ${recettes.size} recette(s).`);
  }

  const ecrire = db.prepare(`
    INSERT INTO craft_recipes
      (nickname, name, product_nick, category, craft_type, factory, command, cooking_rate,
       total_volume, minutes, req_level, loops, restricted, detail, present, synced_at)
    VALUES
      (@nickname, @name, @product_nick, @category, @craft_type, @factory, @command, @cooking_rate,
       @total_volume, @minutes, @req_level, @loops, @restricted, @detail, 1, @synced_at)
    ON CONFLICT(nickname) DO UPDATE SET
      name = excluded.name, product_nick = excluded.product_nick, category = excluded.category,
      craft_type = excluded.craft_type, factory = excluded.factory, command = excluded.command,
      cooking_rate = excluded.cooking_rate, total_volume = excluded.total_volume,
      minutes = excluded.minutes, req_level = excluded.req_level, loops = excluded.loops,
      restricted = excluded.restricted, detail = excluded.detail,
      present = 1, synced_at = excluded.synced_at
  `);
  // Une recette absente du relevé n'est pas supprimée : des commandes y
  // renvoient. Elle sort seulement du catalogue proposé.
  const marquerAbsentes = db.prepare(
    'UPDATE craft_recipes SET present = 0 WHERE synced_at <> ? AND present = 1');
  const ecrireNom = db.prepare(`
    INSERT INTO craft_names (nickname, name, kind, volume) VALUES (?, ?, ?, ?)
    ON CONFLICT(nickname) DO UPDATE SET
      name = excluded.name, kind = excluded.kind, volume = excluded.volume
  `);

  const passe = db.transaction(() => {
    for (const r of recettes.values()) {
      const produit = r.produced[0].nick;
      ecrire.run({
        nickname: r.nickname,
        name: noms.get(produit)?.name || r.infotext || produit,
        product_nick: produit,
        category: categories.get(produit) || 'commodity',
        craft_type: r.craft_type,
        factory: r.factory,
        command: r.command,
        cooking_rate: r.cooking_rate,
        total_volume: r.total_volume,
        minutes: r.minutes,
        req_level: r.req_level,
        loops: r.loops,
        restricted: r.restricted,
        detail: JSON.stringify({
          infotext: r.infotext, produced: r.produced, consumed: r.consumed,
          choices: r.choices, catalysts: r.catalysts, bonuses: r.bonuses,
        }),
        synced_at: stamp,
      });
    }
    for (const [nick, n] of noms) ecrireNom.run(nick, n.name, n.kind, n.volume);
    return marquerAbsentes.run(stamp).changes;
  });

  const disparues = passe();
  setSetting(CLE_DERNIER_RELEVE, stamp);
  return { recettes: recettes.size, noms: noms.size, disparues };
}

export async function syncRecipes() {
  if (enCours) return { skipped: true, reason: 'Un relevé des recettes est déjà en cours.' };
  enCours = true;
  try {
    const bases = await appeler('/api/npc_bases', {
      filter_nicknames: [BASE_FICTIVE], include_market_goods: true, filter_to_useful: false,
    });
    const objets = Array.isArray(bases) ? (bases[0]?.market_goods || []) : [];
    if (!objets.length) throw new Error('La base « crafts » de darkstat ne liste aucun objet.');

    const infocards = await appeler('/api/infocards', objets.map((o) => o.nickname));
    if (!Array.isArray(infocards)) throw new Error('Réponse inattendue : un tableau d’infocards était attendu.');

    // Les noms des marchandises sont un confort : sans eux, les noms lus
    // dans les infocards suffisent à presque tout.
    let marchandises = [];
    try {
      const lu = await appeler(config.darkstat.commoditiesPath);
      if (Array.isArray(lu)) marchandises = lu;
    } catch (err) {
      console.warn(`[recettes] noms des marchandises non relevés : ${err.message}`);
    }

    const bilan = ecrireRecettes(objets, infocards, marchandises);
    console.log(`[recettes] ${bilan.recettes} recette(s) au catalogue` +
      (bilan.disparues ? `, ${bilan.disparues} retirée(s) du jeu` : ''));
    broadcast('production:changed', {});
    return { ok: true, ...bilan };
  } catch (err) {
    // Le catalogue d'hier reste bon : l'échec se consigne, rien n'est effacé.
    console.warn(`[recettes] relevé impossible : ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    enCours = false;
  }
}

function perime() {
  const dernier = getSetting(CLE_DERNIER_RELEVE);
  if (!dernier) return true;
  const age = Date.now() - Date.parse(String(dernier).replace(' ', 'T') + 'Z');
  return !(age < config.darkstat.recipesIntervalMs);
}

/** Comme le catalogue des vaisseaux : on regarde à l'heure s'il a vieilli. */
export function startRecipesWorker() {
  if (minuteur) return;
  const passer = () => { if (perime()) syncRecipes(); };
  setTimeout(passer, 25_000);
  minuteur = setInterval(passer, 3_600_000);
  minuteur.unref?.();
}

export function stopRecipesWorker() {
  if (minuteur) clearInterval(minuteur);
  minuteur = null;
}
