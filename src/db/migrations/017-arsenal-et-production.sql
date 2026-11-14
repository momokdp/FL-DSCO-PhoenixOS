-- =====================================================================
-- 017 — Arsenal : recettes relevées sur darkstat et file de production
--
-- L'armurerie d'origine lisait le .cfg public de Discovery, que le site ne
-- sert plus aux robots : elle est restée vide. darkstat publie les mêmes
-- recettes (ingrédients, catalyseurs, usine, durée, bonus de faction) ;
-- l'arsenal repart donc de là, et gagne ce qui lui manquait : savoir quelle
-- station porte quel module, et tenir une file de commandes par client.
--
-- Les tables `recipes` et `recipe_components` ne sont pas supprimées : plus
-- rien ne les lit, mais des recettes saisies à la main peuvent y dormir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Recettes, telles que darkstat les publie. Clé : le nickname de la
-- recette, seul identifiant stable — plusieurs recettes portent le même
-- nom lisible (variante de base et variante « perk » d'une même pièce).
--
-- Produits, ingrédients, alternatives, catalyseurs et bonus vivent en JSON :
-- ce sont des listes courtes, toujours lues ensemble, jamais interrogées
-- une à une. Les éclater en quatre tables n'apporterait que des jointures.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS craft_recipes (
  nickname      TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,            -- nom lisible du produit principal
  product_nick  TEXT    NOT NULL,            -- produit principal
  category      TEXT    NOT NULL DEFAULT 'commodity',  -- gun, ship, commodity…
  craft_type    TEXT,                        -- famille de recettes côté jeu
  factory       TEXT    NOT NULL DEFAULT '', -- module requis ('' = inconnu)
  command       TEXT,                        -- commande à taper en jeu
  cooking_rate  REAL    NOT NULL DEFAULT 0,  -- volume traité par minute
  total_volume  REAL    NOT NULL DEFAULT 0,
  minutes       REAL    NOT NULL DEFAULT 0,  -- durée d'un lot
  req_level     INTEGER NOT NULL DEFAULT 0,  -- niveau de noyau exigé
  loops         INTEGER NOT NULL DEFAULT 0,  -- 1 = se relance seule
  restricted    INTEGER NOT NULL DEFAULT 0,  -- 1 = réservée aux factions à bonus
  detail        TEXT    NOT NULL,            -- JSON : produced, consumed, choices, catalysts, bonuses
  present       INTEGER NOT NULL DEFAULT 1,  -- 0 = retirée du jeu
  synced_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_craft_recipes_factory ON craft_recipes(factory);

-- Noms lisibles de tout ce qu'une recette cite : marchandises, équipements,
-- vaisseaux, factions. Une marchandise jamais passée par nos soutes n'a pas
-- de fiche dans `items` ; il faut pourtant savoir la nommer.
CREATE TABLE IF NOT EXISTS craft_names (
  nickname      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item','faction')),
  volume        REAL
);

-- ---------------------------------------------------------------------
-- Modules de fabrication posés sur chaque station. darkstat ne les publie
-- pas : un officier les déclare. La clé est le nom d'usine que portent les
-- recettes (« Modular Shipyard »), pas un identifiant inventé ici.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS station_modules (
  station_id    INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  factory       TEXT    NOT NULL,
  PRIMARY KEY (station_id, factory)
);

-- Affiliation et niveau de noyau, relevés avec les stocks. L'affiliation
-- décide des bonus de matériaux et des recettes réservées ; le niveau, des
-- recettes accessibles.
ALTER TABLE stations ADD COLUMN faction_nick TEXT;
ALTER TABLE stations ADD COLUMN faction_name TEXT;
ALTER TABLE stations ADD COLUMN core_level   INTEGER;

-- ---------------------------------------------------------------------
-- Commandes : un client, et les fabrications qu'il attend.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client        TEXT    NOT NULL,
  note          TEXT,
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','delivered')),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_production_orders_open ON production_orders(status, created_at);

-- Une ligne = une recette, en tant d'unités du produit. La recette n'est
-- pas une clé étrangère : une recette retirée du jeu ne doit pas emporter
-- l'historique des commandes, et le nom est donc recopié ici.
CREATE TABLE IF NOT EXISTS production_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  recipe_nick   TEXT    NOT NULL,
  recipe_name   TEXT    NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),   -- unités voulues
  station_id    INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done')),
  started_at    TEXT,
  finished_at   TEXT,
  started_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_production_lines_order ON production_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_production_lines_status ON production_lines(status);
