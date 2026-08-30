-- =====================================================================
-- 011 — Boucles de trade
--
-- Une suggestion aller simple laisse le pilote rentrer à vide. Ce qu'il
-- veut est un circuit : charger chez un vendeur, livrer chez nous,
-- recharger ce que nous produisons, revendre, et revenir au point de
-- départ.
--
-- Trois tables entrent en jeu :
--
--   * path_times   — cache des temps de trajet mesurés par darkstat.
--   * trade_loops  — les circuits retenus, recalculés à chaque passe.
--   * users        — la cale du pilote, qui met les circuits à son échelle.
--
-- Les quantités et les points NE SONT PAS stockés dans trade_loops : ils
-- dépendent de la cale du pilote qui consulte, et se recalculent à la
-- lecture. Seule la topologie du circuit et son économie unitaire sont
-- figées par le calcul horaire.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Le nickname API de nos stations.
--
-- `api_name` sert au rapprochement des stocks, qui tolère indifféremment
-- le nom affiché ou le nickname. /api/graph/paths, lui, n'accepte que le
-- nickname : « Kadesh Orbital City » y est refusé, « kadesh_orbital_city »
-- passe. On retient donc le nickname exact au moment du relevé.
-- ---------------------------------------------------------------------
ALTER TABLE stations ADD COLUMN api_nickname TEXT;

-- ---------------------------------------------------------------------
-- La cale du pilote.
--
-- Fixer la capacité par station serait faux pour quiconque ne vole pas le
-- vaisseau supposé : un même pilote alterne transport et freighter d'un
-- vol à l'autre. C'est donc lui qui la déclare, une fois, et la console
-- s'en souvient.
--
-- NULL signifie « pas encore déclarée » : les circuits sont alors mis à
-- l'échelle d'une cale de référence, et l'écran le dit.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN cargo_capacity INTEGER;
ALTER TABLE users ADD COLUMN ship_class TEXT
  CHECK (ship_class IN ('transport','freighter','frigate'));

-- ---------------------------------------------------------------------
-- Temps de trajet, en secondes, entre deux objets nommés.
--
-- La géographie du jeu ne bouge pas : ce cache est fait pour durer. Il
-- retient aussi les échecs — environ 12 % des bases PNJ sont absentes du
-- graphe (croiseurs de bataille, « Base Placeholder », bases non
-- amarrables) et redemander leur temps à chaque passe serait perdu
-- d'avance. `reachable = 0` marque ces couples, avec des temps nuls.
--
-- `fetched_at` permet de repérer une entrée trop vieille : le graphe peut
-- changer quand le serveur ajoute un trou de ver.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS path_times (
  from_nick   TEXT    NOT NULL,
  to_nick     TEXT    NOT NULL,
  transport   INTEGER,
  frigate     INTEGER,
  freighter   INTEGER,
  reachable   INTEGER NOT NULL DEFAULT 1,
  fetched_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_nick, to_nick)
);

CREATE INDEX IF NOT EXISTS idx_path_times_age ON path_times(fetched_at);

-- ---------------------------------------------------------------------
-- Les circuits.
--
-- Comme les routes automatiques, ils sont intégralement purgés et
-- reconstruits à chaque analyse : ce sont des suggestions dérivées du
-- marché, jamais une saisie à préserver.
--
-- Les temps de trajet ne sont pas recopiés ici : ils vivent dans
-- path_times, d'où on les lit par jointure sur les trois nicknames. Les
-- dupliquer obligerait à choisir un type de vaisseau au calcul, alors que
-- le pilote choisit le sien à la lecture.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_loops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id     INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  station_nick   TEXT    NOT NULL,

  -- Segment 1 : la base fournisseuse vers notre station.
  in_mission_id  INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  in_item_id     INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
  in_base_nick   TEXT    NOT NULL,
  in_base_name   TEXT,
  in_faction     TEXT,
  in_system      TEXT,
  in_sector      TEXT,
  in_region      TEXT,
  in_price       REAL,             -- ce que la base nous réclame, par unité
  in_open_qty    INTEGER NOT NULL, -- reste à couvrir sur la mission
  in_volume      REAL    NOT NULL,
  in_multiplier  REAL    NOT NULL, -- prime de mission × prime de marchandise

  -- Segment 2 : notre station vers la base acheteuse.
  out_mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  out_item_id    INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
  out_base_nick  TEXT    NOT NULL,
  out_base_name  TEXT,
  out_faction    TEXT,
  out_system     TEXT,
  out_sector     TEXT,
  out_region     TEXT,
  out_price      REAL,             -- ce que la base nous paie, par unité
  out_open_qty   INTEGER NOT NULL,
  out_volume     REAL    NOT NULL,
  out_multiplier REAL    NOT NULL,

  -- Points par seconde à la cale de référence, pour un transport. Ne sert
  -- qu'à retenir les meilleurs circuits au moment du calcul : l'écran
  -- refait le score avec la cale et le vaisseau réels du pilote.
  ref_score      REAL    NOT NULL,
  computed_at    TEXT    NOT NULL
);

-- Un même couple de bases ne doit apparaître qu'une fois par station et
-- par paire de marchandises : sans cela, deux offres voisines de la même
-- base rempliraient l'écran de circuits identiques.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_unique
  ON trade_loops(station_id, in_item_id, in_base_nick, out_item_id, out_base_nick);

CREATE INDEX IF NOT EXISTS idx_loop_score ON trade_loops(ref_score DESC);
