/* =====================================================================
   Magasin de sessions, dans la base de la console.

   Il remplace connect-sqlite3, qui embarquait un SECOND pilote SQLite
   (`sqlite3`) à compiler à l'installation, à côté de better-sqlite3 —
   et, avec lui, toute une chaîne d'outils de compilation dont npm
   signalait les failles sans pouvoir les corriger.

   Une session n'est qu'une ligne : son identifiant, son contenu en JSON et
   son échéance. La table vit dans la base principale (migration 013), ce
   qui la fait entrer dans les sauvegardes sans fichier supplémentaire à
   suivre.
   ===================================================================== */

import session from 'express-session';

const UNE_HEURE = 3_600_000;
const UN_JOUR = 24 * UNE_HEURE;

/**
 * Échéance d'une session, en millisecondes depuis l'époque.
 *
 * express-session la porte sur le cookie. Une session sans échéance —
 * cookie « de navigateur » — est gardée un jour : sans borne, elle ne
 * serait jamais purgée.
 */
function echeance(sess) {
  const brut = sess?.cookie?.expires;
  const date = brut ? new Date(brut).getTime() : NaN;
  return Number.isFinite(date) ? date : Date.now() + UN_JOUR;
}

export class SqliteSessionStore extends session.Store {
  /**
   * `db` est la connexion better-sqlite3 de la console. Le magasin est
   * construit par `server.js` APRÈS `migrate()` : préparer ses requêtes ici
   * est donc sûr, la table existe déjà.
   */
  constructor(db, { purgeEveryMs = UNE_HEURE } = {}) {
    super();

    this.lire = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?');
    this.ecrire = db.prepare(`
      INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
    `);
    // Chaque requête d'un pilote connecté repousse l'échéance de sa session.
    // L'écrire à chaque fois ferait une écriture en base par appel d'API,
    // pour gagner quelques secondes sur une session de trente jours : on ne
    // la repousse que lorsqu'elle a pris plus d'une heure de retard.
    this.prolonger = db.prepare(
      'UPDATE sessions SET expires_at = ? WHERE sid = ? AND expires_at < ?');
    this.effacer = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.purger = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

    if (purgeEveryMs > 0) {
      this.minuteur = setInterval(() => {
        try { this.purger.run(Date.now()); } catch (err) {
          console.error('[sessions] purge impossible :', err.message);
        }
      }, purgeEveryMs);
      // La purge ne doit pas retenir le processus à l'arrêt.
      this.minuteur.unref();
    }
  }

  get(sid, done) {
    try {
      const ligne = this.lire.get(sid, Date.now());
      done(null, ligne ? JSON.parse(ligne.sess) : null);
    } catch (err) { done(err); }
  }

  set(sid, sess, done = () => {}) {
    try {
      this.ecrire.run(sid, JSON.stringify(sess), echeance(sess));
      done(null);
    } catch (err) { done(err); }
  }

  touch(sid, sess, done = () => {}) {
    try {
      const jusqua = echeance(sess);
      this.prolonger.run(jusqua, sid, jusqua - UNE_HEURE);
      done(null);
    } catch (err) { done(err); }
  }

  destroy(sid, done = () => {}) {
    try {
      this.effacer.run(sid);
      done(null);
    } catch (err) { done(err); }
  }

  /** Arrête la purge périodique. */
  close() {
    clearInterval(this.minuteur);
  }
}
