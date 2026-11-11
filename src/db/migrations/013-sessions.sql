-- =====================================================================
-- 013 — Sessions dans la base de la console
--
-- Les sessions vivaient dans un fichier à part, `sessions.sqlite`, tenu
-- par connect-sqlite3. Ce paquet imposait un second pilote SQLite à
-- compiler à l'installation ; le magasin est désormais écrit sur
-- better-sqlite3 (`src/auth/sessionStore.js`) et range ses lignes ici.
--
-- Les sessions de l'ancien fichier ne sont pas reprises : chaque pilote se
-- reconnecte une fois. `data/sessions.sqlite` peut ensuite être supprimé.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT    PRIMARY KEY,
  sess        TEXT    NOT NULL,          -- contenu de la session, en JSON
  expires_at  INTEGER NOT NULL           -- échéance, en millisecondes
);

-- La purge périodique retire les sessions échues.
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
