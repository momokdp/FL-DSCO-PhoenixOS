-- =====================================================================
-- 004 — Annulation d'une livraison
--
-- Une livraison saisie par erreur (essai, faute de frappe, mission non
-- réalisée) doit pouvoir être retirée : elle fausse le stock effectif et
-- le classement du mois.
--
-- SQLite ne sait pas modifier une contrainte CHECK. On reconstruit donc
-- la table, ce qui est sûr ici car tout le fichier s'exécute dans une
-- seule transaction : en cas d'échec, rien n'est perdu.
-- =====================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE mission_claims_nouveau (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id    INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress','delivered','abandoned','expired','cancelled')),
  pledged_qty   INTEGER NOT NULL DEFAULT 0,
  delivered_qty INTEGER NOT NULL DEFAULT 0,
  points        REAL    NOT NULL DEFAULT 0,
  claimed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,

  -- Traçabilité de l'annulation : qui, quand, pourquoi.
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT
);

INSERT INTO mission_claims_nouveau
  (id, mission_id, user_id, status, pledged_qty, delivered_qty, points, claimed_at, closed_at)
SELECT
  id, mission_id, user_id, status, pledged_qty, delivered_qty, points, claimed_at, closed_at
FROM mission_claims;

DROP TABLE mission_claims;
ALTER TABLE mission_claims_nouveau RENAME TO mission_claims;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_unique
  ON mission_claims(mission_id, user_id) WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_claim_user_closed
  ON mission_claims(user_id, closed_at DESC);

PRAGMA foreign_keys = ON;
