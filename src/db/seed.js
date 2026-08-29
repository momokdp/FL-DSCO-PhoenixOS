import { db, migrate, setSetting } from './index.js';

const reset = process.argv.includes('--reset');

migrate();

if (reset) {
  console.log('Réinitialisation : suppression des données métier…');
  db.exec(`
    DELETE FROM mission_claims; DELETE FROM missions;
    DELETE FROM stock_adjustments; DELETE FROM stock_snapshots;
    DELETE FROM station_status; DELETE FROM recipe_components;
    DELETE FROM recipes; DELETE FROM routes; DELETE FROM stations; DELETE FROM items;
  `);
}

// Vos quatre bases. api_name doit correspondre EXACTEMENT au champ name
// renvoyé par /api/pobs — c'est la clé de rapprochement.
const stations = [
  { name: 'Kadesh Orbital City', api_name: 'Kadesh Orbital City', code: 'KOC', system: null, sort_order: 1 },
  { name: 'Sparta Complex',      api_name: 'Sparta Complex',      code: 'SPC', system: null, sort_order: 2 },
  { name: 'Athens Station',      api_name: 'Athens Station',      code: 'ATH', system: null, sort_order: 3 },
  { name: 'Pytheas Observatory', api_name: 'Pytheas Observatory', code: 'PYT', system: null, sort_order: 4 },
];

const insertStation = db.prepare(`
  INSERT INTO stations (name, api_name, code, system, sort_order)
  VALUES (@name, @api_name, @code, @system, @sort_order)
  ON CONFLICT(api_name) DO UPDATE SET
    name = excluded.name, code = excluded.code, sort_order = excluded.sort_order
`);

db.transaction(() => {
  for (const s of stations) insertStation.run(s);
})();

setSetting('faction_name', 'Kadesh');
setSetting('console_title', 'Console logistique Kadesh');
setSetting('auto_mission_enabled', '1');

const counts = {
  stations: db.prepare('SELECT COUNT(*) AS n FROM stations').get().n,
  items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
};

console.log('\nBase prête.');
console.log(`  Stations : ${counts.stations}`);
console.log(`  Marchandises : ${counts.items} (remplies à la première synchronisation)`);
console.log(`  Utilisateurs : ${counts.users}`);
console.log('\nLe premier compte Discord qui se connecte devient administrateur.\n');

db.close();
