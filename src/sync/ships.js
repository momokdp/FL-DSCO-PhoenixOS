/* =====================================================================
   Catalogue des vaisseaux.

   darkstat publie, pour chaque modèle du jeu, son nom, son type et la
   taille de sa soute. C'est ce relevé qui donne sa soute au vaisseau d'un
   pilote : il choisit un modèle, il ne déclare pas un chiffre.

   Le catalogue ne bouge qu'aux mises à jour du jeu. Un relevé par jour
   suffit largement, et la réponse pèse près d'un mégaoctet : la
   redemander à la cadence des stocks serait du gaspillage.
   ===================================================================== */

import { config } from '../config.js';
import { db, nowSql, getSetting, setSetting } from '../db/index.js';

const CLE_DERNIER_RELEVE = 'ships_synced_at';

// En deçà, la réponse n'est pas un catalogue : une liste tronquée ou vide
// ferait passer presque tous les modèles pour disparus du jeu.
const MINIMUM_VRAISEMBLABLE = 50;

let minuteur = null;
let enCours = false;

async function lireCatalogue() {
  const url = config.darkstat.baseUrl + config.darkstat.shipsPath;
  const ctrl = new AbortController();
  // La réponse est bien plus lourde que celle des stocks : on lui laisse
  // le triple du délai ordinaire.
  const delai = config.darkstat.timeoutMs * 3;
  const timeout = setTimeout(() => ctrl.abort(), delai);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'KadeshConsole/1.0' },
    });
    if (!res.ok) throw new Error(`darkstat a répondu HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Réponse inattendue : un tableau de vaisseaux était attendu.');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`darkstat n’a pas répondu en ${delai} ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ne garde d'un vaisseau que ce que la console utilise.
 *
 * Une soute illisible vaut 0 plutôt qu'un rejet : le modèle reste
 * choisissable, il n'emporte simplement rien.
 */
export function modeleDepuis(brut) {
  const nickname = String(brut?.nickname ?? '').trim();
  const name = String(brut?.name ?? '').trim();
  if (!nickname || !name) return null;

  const soute = Number(brut.hold_size);
  return {
    nickname,
    name,
    type: typeof brut.type === 'string' && brut.type ? brut.type.toLowerCase() : null,
    hold_size: Number.isFinite(soute) && soute > 0 ? Math.round(soute) : 0,
  };
}

/** Écrit le catalogue. Séparée du réseau pour pouvoir être éprouvée seule. */
export function ecrireCatalogue(bruts, stamp = nowSql()) {
  const modeles = bruts.map(modeleDepuis).filter(Boolean);
  if (modeles.length < MINIMUM_VRAISEMBLABLE) {
    throw new Error(`Catalogue trop court pour être vrai : ${modeles.length} modèle(s).`);
  }

  const ecrire = db.prepare(`
    INSERT INTO ship_models (nickname, name, type, hold_size, present, synced_at)
    VALUES (@nickname, @name, @type, @hold_size, 1, @synced_at)
    ON CONFLICT(nickname) DO UPDATE SET
      name = excluded.name, type = excluded.type, hold_size = excluded.hold_size,
      present = 1, synced_at = excluded.synced_at
  `);
  // Un modèle absent du relevé n'est pas supprimé : des vaisseaux de
  // pilotes y renvoient. Il sort seulement de la liste proposée.
  const marquerAbsents = db.prepare(
    'UPDATE ship_models SET present = 0 WHERE synced_at <> ? AND present = 1');

  const passe = db.transaction(() => {
    for (const m of modeles) ecrire.run({ ...m, synced_at: stamp });
    return marquerAbsents.run(stamp).changes;
  });

  const disparus = passe();
  setSetting(CLE_DERNIER_RELEVE, stamp);
  return { modeles: modeles.length, disparus };
}

export async function syncShips() {
  if (enCours) return { skipped: true };
  enCours = true;
  try {
    const bilan = ecrireCatalogue(await lireCatalogue());
    console.log(`[vaisseaux] ${bilan.modeles} modèle(s) au catalogue` +
      (bilan.disparus ? `, ${bilan.disparus} retiré(s) du jeu` : ''));
    return { ok: true, ...bilan };
  } catch (err) {
    // Un catalogue d'hier reste bon : l'échec se consigne, rien n'est effacé.
    console.warn(`[vaisseaux] relevé impossible : ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    enCours = false;
  }
}

/** Vrai quand le dernier relevé réussi date de plus d'un intervalle. */
function perime() {
  const dernier = getSetting(CLE_DERNIER_RELEVE);
  if (!dernier) return true;
  const age = Date.now() - Date.parse(String(dernier).replace(' ', 'T') + 'Z');
  return !(age < config.darkstat.shipsIntervalMs);
}

/**
 * Le minuteur ne compte pas un jour depuis le démarrage : il regarde à
 * l'heure si le catalogue a vieilli. Un service relancé chaque nuit ne
 * relèverait sinon jamais, ou relèverait à chaque relance.
 */
export function startShipsWorker() {
  if (minuteur) return;
  const passer = () => { if (perime()) syncShips(); };
  setTimeout(passer, 15_000);
  minuteur = setInterval(passer, 3_600_000);
  minuteur.unref?.();
}

export function stopShipsWorker() {
  if (minuteur) clearInterval(minuteur);
  minuteur = null;
}
