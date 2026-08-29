/**
 * Applique les migrations en attente, hors du serveur.
 * Utile pour vérifier une mise à jour avant de redémarrer le service :
 *     npm run migrate
 */
import { migrate } from './index.js';

try {
  const { applied, backup } = migrate();
  if (!applied.length) {
    console.log('Base à jour, aucune migration en attente.');
  } else {
    if (backup) console.log(`Sauvegarde : ${backup}`);
    console.log(`${applied.length} migration(s) appliquée(s).`);
  }
  process.exit(0);
} catch (err) {
  console.error(`\nÉchec : ${err.message}\n`);
  process.exit(1);
}
