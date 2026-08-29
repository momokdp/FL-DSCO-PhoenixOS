/**
 * Sauvegarde à chaud de la base, service en marche.
 *     npm run backup
 */
import { backupNow } from './index.js';

try {
  console.log(backupNow('sauvegarde'));
  process.exit(0);
} catch (err) {
  console.error(`Sauvegarde impossible : ${err.message}`);
  process.exit(1);
}
