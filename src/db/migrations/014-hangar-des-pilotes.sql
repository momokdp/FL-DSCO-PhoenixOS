-- =====================================================================
-- 014 — Le hangar des pilotes
--
-- Jusqu'ici le pilote déclarait un chiffre : la cale de « son » vaisseau,
-- un seul, saisi à la main. Deux défauts en découlaient. Rien ne bornait
-- la quantité déclarée à la livraison, donc les points qu'elle rapporte.
-- Et un pilote qui alterne deux vaisseaux devait ressaisir sa cale à
-- chaque changement.
--
-- Le pilote tient désormais un hangar : plusieurs vaisseaux, chacun
-- rattaché à un modèle du jeu. La soute n'est plus déclarée, elle vient du
-- catalogue relevé sur darkstat — si une mise à jour du jeu la change,
-- tous les vaisseaux de ce modèle suivent sans intervention.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Le catalogue des modèles, recopié de /api/ships.
--
-- Le nickname est la seule clé sûre : plusieurs modèles portent le même
-- nom affiché (variantes d'un même vaisseau).
--
-- `present` passe à 0 quand un modèle disparaît du relevé. La ligne
-- reste : des vaisseaux de pilotes et des livraisons passées y renvoient,
-- et sa dernière soute connue vaut mieux que rien.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ship_models (
  nickname   TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  type       TEXT,
  hold_size  INTEGER NOT NULL DEFAULT 0,
  present    INTEGER NOT NULL DEFAULT 1,
  synced_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------
-- Les vaisseaux des pilotes.
--
-- `model_nick` NULL marque un vaisseau repris de l'ancienne déclaration :
-- on connaît la cale que le pilote avait saisie, pas son modèle. Il sert
-- encore à estimer les circuits, mais pas à prendre une mission tant que
-- le pilote ne l'a pas rattaché à un modèle.
--
-- Un vaisseau retiré n'est pas supprimé : les engagements livrés avec lui
-- y renvoient toujours. `retired_at` le sort simplement du hangar.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pilot_ships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_nick    TEXT    REFERENCES ship_models(nickname),
  name          TEXT    NOT NULL,
  legacy_cargo  INTEGER,
  legacy_class  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  retired_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_pilot_ships_user ON pilot_ships(user_id, retired_at);

-- Le vaisseau proposé par défaut à la prise de mission, et celui sur
-- lequel les circuits sont mis à l'échelle.
ALTER TABLE users ADD COLUMN active_ship_id INTEGER REFERENCES pilot_ships(id);

-- Le vaisseau engagé sur la mission : c'est sa soute qui plafonne la
-- quantité livrée. NULL sur les engagements antérieurs au hangar.
ALTER TABLE mission_claims ADD COLUMN ship_id INTEGER REFERENCES pilot_ships(id);

-- ---------------------------------------------------------------------
-- Reprise de l'existant : la cale déjà déclarée devient un vaisseau « à
-- préciser », actif d'office. Les colonnes users.cargo_capacity et
-- users.ship_class ne sont plus lues ; elles restent en place, les
-- retirer n'apporterait rien et rendrait la migration irréversible.
-- ---------------------------------------------------------------------
INSERT INTO pilot_ships (user_id, name, legacy_cargo, legacy_class)
SELECT id, 'Vaisseau à préciser', cargo_capacity, ship_class
FROM users
WHERE cargo_capacity IS NOT NULL AND cargo_capacity > 0;

UPDATE users
SET active_ship_id = (SELECT ps.id FROM pilot_ships ps WHERE ps.user_id = users.id)
WHERE EXISTS (SELECT 1 FROM pilot_ships ps WHERE ps.user_id = users.id);
