-- =====================================================================
-- 016 — Le volume d'une marchandise dépend du vaisseau qui l'emporte
--
-- Le hangar plafonne un voyage à la soute du vaisseau, divisée par le
-- volume unitaire de la marchandise. Ce volume était tenu pour le même
-- sur tous les vaisseaux. Le jeu, lui, le réduit pour certaines classes :
-- un vaisseau de minage prend le minerai à moitié volume, un paquebot
-- ses passagers, un chasseur les pilotes capturés. L'Hegemon — 5 000 de
-- soute — emporte 10 000 unités d'Iron en jeu, et la console lui en
-- refusait la moitié.
--
-- Ce volume réduit ne sert qu'à dire ce qui tient en soute. Les points
-- de mérite restent calculés sur le volume de référence, items.volume.
-- =====================================================================

-- La classe du modèle au sens du jeu : l'entier que darkstat publie dans
-- « class ». À ne pas confondre avec le type (transport, freighter…), qui
-- ne donne que l'allure de vol. NULL tant que le catalogue n'a pas été
-- relevé depuis cette migration.
ALTER TABLE ship_models ADD COLUMN game_class INTEGER;

-- ---------------------------------------------------------------------
-- Les volumes propres à une classe, recopiés de /api/commodities.
--
-- Seules les exceptions y figurent : une marchandise sans ligne pour la
-- classe d'un vaisseau garde son volume de référence.
--
-- La clé est le nickname de la marchandise, celui que porte
-- items.commodity_id, et non l'identifiant de la ligne `items` : le
-- barème vaut pour le jeu entier, que nos stations tiennent déjà la
-- marchandise ou non.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hold_volumes (
  commodity_nick TEXT    NOT NULL,
  game_class     INTEGER NOT NULL,
  volume         REAL    NOT NULL,
  synced_at      TEXT    NOT NULL,
  PRIMARY KEY (commodity_nick, game_class)
);
