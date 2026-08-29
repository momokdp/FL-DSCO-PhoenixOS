import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);

// WAL : lectures concurrentes pendant que le worker de synchronisation écrit.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const MIGRATIONS_DIR = path.join(here, 'migrations');

/**
 * Applique les migrations en attente, dans l'ordre des noms de fichiers.
 *
 * Rejouer schema.sql à chaque démarrage ne suffisait pas : tout étant en
 * « CREATE TABLE IF NOT EXISTS », une colonne ajoutée à une table déjà
 * existante n'aurait jamais été créée, et l'application aurait planté sur
 * une base de production avec « no such column ».
 *
 * Chaque fichier n'est appliqué qu'une fois, dans une transaction. En cas
 * d'échec, la base reste exactement dans l'état où elle était.
 */
export function migrate({ verbose = true } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Deux fichiers portant le même numéro sont une erreur, jamais une
  // intention : l'ordre entre eux dépendrait du tri alphabétique du reste
  // du nom, et un seul serait retenu si l'autre a déjà été appliqué.
  const parNumero = new Map();
  for (const f of files) {
    const n = f.slice(0, 3);
    if (parNumero.has(n)) {
      throw new Error(
        `Deux migrations portent le numéro ${n} : « ${parNumero.get(n)} » et « ${f} ». ` +
        `Renumérotez-en une avant de démarrer.`
      );
    }
    parNumero.set(n, f);
  }

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );
  const pending = files.filter((f) => !applied.has(f));

  if (!pending.length) return { applied: [], backup: null };

  // Une base neuve n'a rien à sauvegarder. Une base existante, si.
  const backup = applied.size > 0 ? backupNow('avant-migration') : null;
  if (backup && verbose) console.log(`[migration] sauvegarde : ${backup}`);

  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      db.exec('BEGIN');
      db.exec(sql);
      record.run(file);
      db.exec('COMMIT');
      if (verbose) console.log(`[migration] ${file} appliquée`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* transaction déjà défaite */ }
      throw new Error(
        `Migration « ${file} » interrompue : ${err.message}\n` +
        `La base est inchangée.` +
        (backup ? ` Sauvegarde disponible : ${backup}` : '')
      );
    }
  }

  return { applied: pending, backup };
}

/**
 * Copie cohérente de la base, service en marche.
 *
 * VACUUM INTO produit un fichier propre sans le journal WAL, contrairement
 * à une copie du fichier qui serait tronquée.
 */
export function backupNow(etiquette = 'sauvegarde') {
  const dir = path.join(path.dirname(config.dbFile), 'sauvegardes');
  fs.mkdirSync(dir, { recursive: true });

  const horodatage = new Date().toISOString().slice(0, 23).replace(/[:T.]/g, '-');

  // VACUUM INTO refuse d'écrire sur un fichier existant. Sans ce garde-fou,
  // deux sauvegardes rapprochées échouaient et bloquaient la migration.
  let cible = path.join(dir, `${etiquette}-${horodatage}.sqlite`);
  for (let n = 2; fs.existsSync(cible); n++) {
    cible = path.join(dir, `${etiquette}-${horodatage}-${n}.sqlite`);
  }

  db.exec(`VACUUM INTO '${cible.replace(/'/g, "''")}'`);
  return cible;
}

/** Horodatage au format exact de datetime('now') pour comparaisons de chaînes. */
/**
 * Horodatage SQL en UTC, à la milliseconde.
 *
 * La précision compte : le stock effectif ne retient que les livraisons
 * POSTÉRIEURES au dernier relevé. À la seconde près, une livraison tombant
 * dans la même seconde qu'une synchronisation était purement et simplement
 * ignorée. Le format reste comparable en chaîne avec datetime('now').
 */
export function nowSql() {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

/** Lit un réglage, avec valeur de repli. */
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

/** Trace une action dans le journal d'audit. */
export function audit(userId, action, entity = null, entityId = null, detail = null) {
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId ?? null, action, entity, entityId, detail ? JSON.stringify(detail) : null);
}

/** Enveloppe une fonction dans une transaction. */
export function tx(fn) {
  return db.transaction(fn);
}
