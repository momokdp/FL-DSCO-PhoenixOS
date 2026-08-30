/* =====================================================================
   Temps de trajet.

   darkstat expose, pour un couple d'objets nommés, le temps de vol en
   secondes selon le type de vaisseau. C'est la mesure qui permet de
   classer un circuit sur ce qu'un pilote arbitre réellement : le temps
   passé, pas la marge brute.

   Deux propriétés de l'endpoint gouvernent ce module :

   * L'appel est GROUPÉ. Le corps est un tableau de couples, et 400 couples
     reviennent en 150 ms. Interroger couple par couple, comme on l'avait
     d'abord supposé, aurait rendu la mesure trop chère pour servir.

   * Le résultat ne bouge pas. La carte du jeu est fixe : un temps mesuré
     reste valable jusqu'à ce que le serveur ajoute un passage. On le range
     donc dans `path_times` et on ne le redemande plus.
   ===================================================================== */

import { config } from '../config.js';
import { db } from '../db/index.js';

/**
 * Au-delà de cette valeur, un temps est une sentinelle, pas une mesure.
 *
 * darkstat rend 9223372036854775807 quand la destination est injoignable.
 * On ne compare pas à cette valeur exacte : elle dépasse
 * Number.MAX_SAFE_INTEGER et l'égalité stricte y devient illusoire après
 * passage en double. Le plus long trajet réel se compte en heures ; un
 * seuil à cent ans écarte la sentinelle sans risquer d'écarter une mesure.
 */
const PLAFOND_VRAISEMBLABLE = 100 * 365 * 24 * 3600;

export const CLASSES = ['transport', 'freighter', 'frigate'];

// Séparateur impossible dans un nickname : la clé composée reste sans
// ambiguïté quelle que soit la forme des noms rendus par darkstat.
const cle = (from, to) => `${from}\u0000${to}`;

const estMesure = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < PLAFOND_VRAISEMBLABLE;
};

/* ------------------------------------------------------------- cache */

/**
 * Requêtes préparées à la première utilisation, jamais au chargement.
 *
 * `server.js` appelle `migrate()` dans son corps, mais les imports ESM sont
 * tous évalués AVANT. Préparer ici une requête sur `path_times` la ferait
 * donc s'exécuter contre le schéma d'AVANT la migration : sur une base déjà
 * déployée, le serveur mourait sur « no such table » sans jamais atteindre
 * la migration censée créer la table. C'est la convention du projet : aucun
 * `db.prepare` au niveau module.
 */
let lireCache = null;
let ecrireCache = null;

function requetes() {
  if (!lireCache) {
    lireCache = db.prepare(`
      SELECT from_nick, to_nick, transport, frigate, freighter, reachable
      FROM path_times
      WHERE fetched_at >= datetime('now', ?)
    `);
    ecrireCache = db.prepare(`
      INSERT INTO path_times (from_nick, to_nick, transport, frigate, freighter, reachable, fetched_at)
      VALUES (@from_nick, @to_nick, @transport, @frigate, @freighter, @reachable, datetime('now'))
      ON CONFLICT(from_nick, to_nick) DO UPDATE SET
        transport  = excluded.transport,
        frigate    = excluded.frigate,
        freighter  = excluded.freighter,
        reachable  = excluded.reachable,
        fetched_at = excluded.fetched_at
    `);
  }
  return { lireCache, ecrireCache };
}

/* -------------------------------------------------------- récupération */

/**
 * Un lot de couples, en un appel.
 *
 * Un couple en erreur n'invalide pas le lot : darkstat répond couple par
 * couple, et environ 12 % des bases PNJ sont absentes du graphe. On rend
 * donc les mesures obtenues et on marque les autres injoignables, plutôt
 * que d'abandonner tout le lot pour un croiseur non amarrable.
 */
async function interroger(lot) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), config.darkstat.timeoutMs ?? 20000);

  try {
    const res = await fetch(`${config.darkstat.baseUrl}/api/graph/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Les bases joueur se désignent par leur nickname NU. Le swagger
      // annonce un nom encodé en base64 : c'est faux, il répond alors
      // « destination is not found ».
      body: JSON.stringify(lot.map(([from, to]) => ({ from, to }))),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[trajets] /api/graph/paths a répondu ${res.status} ${detail.slice(0, 120)}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[trajets] /api/graph/paths injoignable : ${err.message}`);
    return [];
  } finally {
    clearTimeout(minuteur);
  }
}

/* ---------------------------------------------------------------- API */

/**
 * Temps de trajet pour une liste de couples `[from, to]`.
 *
 * Renvoie une Map dont la clé est `from\0to` et la valeur porte les trois
 * types de vaisseau, plus `reachable`. Un couple absent du cache ET absent
 * de la réponse reste absent de la Map : à l'appelant de traiter le
 * manque, jamais de le prendre pour un temps nul.
 *
 * `offline` interdit tout appel réseau et se contente du cache : c'est le
 * mode des écrans servis à un pilote, qui ne doit pas attendre darkstat.
 */
export async function tempsDeTrajet(couples, { offline = false } = {}) {
  const voulus = new Map();
  for (const [from, to] of couples) {
    // Un couple identique n'a pas de trajet, et darkstat le refuserait.
    if (!from || !to || from === to) continue;
    voulus.set(cle(from, to), [String(from), String(to)]);
  }
  if (!voulus.size) return new Map();

  const { lireCache, ecrireCache } = requetes();
  const resultat = new Map();

  // Le cache d'abord. Une entrée trop ancienne est réinterrogée : le
  // graphe change quand le serveur ouvre un nouveau passage.
  const age = `-${Math.max(1, config.darkstat.pathsMaxAgeDays)} days`;
  for (const r of lireCache.all(age)) {
    const k = cle(r.from_nick, r.to_nick);
    if (!voulus.has(k)) continue;
    resultat.set(k, {
      transport: r.transport,
      frigate: r.frigate,
      freighter: r.freighter,
      reachable: r.reachable === 1,
    });
    voulus.delete(k);
  }

  if (!voulus.size || offline) return resultat;

  const manquants = [...voulus.values()];
  const taille = Math.max(1, config.darkstat.pathsBatchSize);
  const aRanger = [];

  for (let i = 0; i < manquants.length; i += taille) {
    const lot = manquants.slice(i, i + taille);
    const reponse = await interroger(lot);

    // On réindexe la réponse sur le couple demandé : darkstat renvoie bien
    // l'entrée `route` telle qu'elle a été soumise, mais rien dans le
    // contrat ne garantit l'ordre du tableau.
    const parCouple = new Map();
    for (const entree of reponse) {
      const from = entree?.route?.from;
      const to = entree?.route?.to;
      if (from && to) parCouple.set(cle(from, to), entree);
    }

    for (const [from, to] of lot) {
      const k = cle(from, to);
      const entree = parCouple.get(k);

      // Une absence pure de réponse n'est pas une preuve d'injoignabilité :
      // elle vient tout aussi bien d'un appel échoué. On ne la met pas en
      // cache, sinon une panne réseau condamnerait des bases valides.
      if (!entree) continue;

      // Deux échecs distincts, un même traitement : la base est hors du
      // graphe (`error`) ou la destination est injoignable (sentinelle).
      // Dans les deux cas il n'y a pas de trajet, et le mémoriser évite de
      // le redemander à chaque passe.
      const temps = entree.time;
      const mesure = temps && CLASSES.every((c) => estMesure(temps[c]));

      const ligne = mesure
        ? {
          transport: Math.round(Number(temps.transport)),
          frigate: Math.round(Number(temps.frigate)),
          freighter: Math.round(Number(temps.freighter)),
          reachable: true,
        }
        : { transport: null, frigate: null, freighter: null, reachable: false };

      // SQLite ne sait pas lier un booléen : `reachable` voyage en 0/1 vers
      // la base, et reste un booléen dans la Map rendue à l'appelant.
      aRanger.push({ ...ligne, from_nick: from, to_nick: to, reachable: ligne.reachable ? 1 : 0 });
      resultat.set(k, ligne);
    }
  }

  if (aRanger.length) {
    db.transaction(() => { for (const l of aRanger) ecrireCache.run(l); })();
  }

  return resultat;
}

/** Temps d'un couple pour un type de vaisseau, ou null s'il n'y en a pas. */
export function secondes(mesures, from, to, classe = 'transport') {
  const m = mesures.get(cle(from, to));
  if (!m || !m.reachable) return null;
  const v = m[CLASSES.includes(classe) ? classe : 'transport'];
  return Number.isFinite(v) && v > 0 ? v : null;
}

export { cle as clePath };
