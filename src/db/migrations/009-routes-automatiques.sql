-- =====================================================================
-- 009 — Routes automatiques et réputations interdites
--
-- Les champs « Où charger » et « Où emmener » étaient saisis à la main.
-- darkstat expose pourtant, pour chaque marchandise, les bases qui la
-- vendent et celles qui l'achètent, avec leurs prix. On peut donc
-- proposer la route au lieu de la faire saisir.
--
-- Les routes calculées et les routes saisies cohabitent : une route
-- manuelle porte une connaissance que l'API n'a pas (vendeur hostile,
-- passage à éviter) et l'emporte toujours.
-- =====================================================================

ALTER TABLE routes ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN direction TEXT
  CHECK (direction IN ('import','export'));
ALTER TABLE routes ADD COLUMN base_nickname TEXT;
ALTER TABLE routes ADD COLUMN faction_name  TEXT;
ALTER TABLE routes ADD COLUMN system_name   TEXT;
ALTER TABLE routes ADD COLUMN sector_coord  TEXT;
ALTER TABLE routes ADD COLUMN price         REAL;
ALTER TABLE routes ADD COLUMN computed_at   TEXT;

-- Une route calculée est identifiée par la mission qu'elle sert et la base
-- proposée : on la remplace à chaque analyse au lieu d'empiler des lignes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_auto
  ON routes(item_id, dest_id, direction, base_nickname) WHERE auto = 1;

-- ---------------------------------------------------------------------
-- Factions dont les bases ne doivent jamais être proposées.
--
-- Une base peut vendre au meilleur prix et rester inaccessible : réputation
-- hostile, doctrine de l'escadrille, zone de guerre.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocked_factions (
  faction_name TEXT PRIMARY KEY,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE routes ADD COLUMN margin REAL;
