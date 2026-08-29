import { migrate, db } from '../db/index.js';
import { syncNow } from './darkstat.js';

migrate();
const result = await syncNow({ trigger: 'ligne de commande' });

if (result.ok) {
  console.log(`Relevé terminé : ${result.stationsSeen} station(s), ${result.rowsWritten} ligne(s).`);
  if (result.missing?.length) {
    console.warn(`Introuvables côté API : ${result.missing.join(', ')}`);
    console.warn("Vérifiez le champ « nom API » de ces stations dans l'administration.");
  }
} else {
  console.error(`Échec : ${result.error}`);
  process.exitCode = 1;
}

db.close();
