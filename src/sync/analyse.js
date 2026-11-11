/* =====================================================================
   Passe d'analyse du marché.

   Deux calculs se suivent, dans cet ordre et dans la même passe :

     1. les routes automatiques — pour chaque mission, la base qui sert au
        meilleur prix ;
     2. les boucles de trade — l'assemblage de deux missions en circuit,
        classé au temps de vol réel.

   Ils sont réunis ici pour deux raisons. Ils lisent le même marché, à la
   même cadence : les faire tourner séparément doublerait les appels à
   darkstat pour un résultat identique. Et le module qui les enchaîne doit
   être distinct des deux, sinon `loops.js`, qui lit déjà le marché via
   `routes.js`, formerait un cycle d'imports avec lui.

   La cadence reste celle des routes : les prix bougent à l'échelle de
   l'heure, pas du quart d'heure. Le premier passage est différé de deux
   minutes pour laisser un relevé de stock arriver — sans missions
   ouvertes, il n'y aurait rien à chercher.
   ===================================================================== */

import { config } from '../config.js';
import { analyserRoutes, lireMarche } from './routes.js';
import { analyserBoucles } from './loops.js';

let minuteur = null;

/**
 * Une passe complète.
 *
 * L'échec d'un des deux calculs n'empêche pas l'autre : des routes sans
 * boucles restent utiles, et l'inverse aussi.
 */
export async function analyserMarche() {
  const bilan = {};

  // Un seul relevé pour les deux calculs. Chacun lisait le marché de son
  // côté : deux téléchargements complets, coup sur coup, du même contenu.
  // `lireMarche` ne rejette pas : injoignable, darkstat donne un marché
  // vide, que chaque calcul signale à sa manière.
  const marche = await lireMarche();

  try {
    const r = await analyserRoutes(marche);
    bilan.routes = r;
    if (r.ok) console.log(`[routes] ${r.trouvees}/${r.analysees} route(s) suggérée(s)`);
    else console.warn(`[routes] ${r.error}`);
  } catch (err) {
    bilan.routes = { ok: false, error: err.message };
    console.warn(`[routes] échec : ${err.message}`);
  }

  try {
    const b = await analyserBoucles(marche);
    bilan.boucles = b;
    if (b.ok) {
      console.log(`[boucles] ${b.boucles} circuit(s) sur ${b.stations} station(s)` +
        (b.couplesMesures ? ` — ${b.couplesMesures} trajet(s) éprouvé(s)` : ''));
    } else {
      console.warn(`[boucles] ${b.error}`);
    }
  } catch (err) {
    bilan.boucles = { ok: false, error: err.message };
    console.warn(`[boucles] échec : ${err.message}`);
  }

  return bilan;
}

export function startAnalyseWorker() {
  const every = config.darkstat.routesIntervalMs;
  if (!every || every < 60_000) return;

  setTimeout(analyserMarche, 120_000);
  minuteur = setInterval(analyserMarche, every);
  console.log(`[analyse] routes et boucles toutes les ${Math.round(every / 60000)} min`);
}

export function stopAnalyseWorker() {
  if (minuteur) clearInterval(minuteur);
  minuteur = null;
}
