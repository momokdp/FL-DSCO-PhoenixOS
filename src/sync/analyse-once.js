/* =====================================================================
   Analyse du marché en ligne de commande.

   La passe automatique est horaire et différée de deux minutes au
   démarrage. Après une première installation, ou après avoir réglé des
   seuils, on veut voir les routes et les boucles tout de suite plutôt que
   d'attendre le prochain tour.
   ===================================================================== */

import { migrate, db } from '../db/index.js';
import { analyserMarche } from './analyse.js';

migrate();

const { routes, boucles } = await analyserMarche();

if (routes?.ok) {
  console.log(`Routes : ${routes.trouvees} suggérée(s) sur ${routes.analysees} mission(s).`);
} else {
  console.error(`Routes : échec — ${routes?.error}`);
  process.exitCode = 1;
}

if (boucles?.ok) {
  console.log(`Boucles : ${boucles.boucles} circuit(s) sur ${boucles.stations} station(s).`);
  if (boucles.note) console.log(`  ${boucles.note}`);
} else {
  console.error(`Boucles : échec — ${boucles?.error}`);
  process.exitCode = 1;
}

// Sans nickname API, une station ne peut entrer dans aucun circuit :
// /api/graph/paths refuse les noms affichés. Le nickname est renseigné au
// relevé de stock, donc un « npm run sync:now » corrige la situation.
const muettes = db.prepare(`
  SELECT name FROM stations
  WHERE active = 1 AND (api_nickname IS NULL OR api_nickname = '')
`).all().map((r) => r.name);

if (muettes.length) {
  console.warn(`\nSans identifiant API, donc hors circuits : ${muettes.join(', ')}`);
  console.warn('Lancez « npm run sync:now » : le relevé de stock le renseigne.');
}

db.close();
