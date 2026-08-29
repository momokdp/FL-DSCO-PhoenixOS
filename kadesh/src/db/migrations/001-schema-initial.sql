-- =====================================================================
-- 001 — Schéma initial
--
-- Première migration : elle porte l'intégralité du schéma d'origine.
-- Ne la modifiez JAMAIS une fois déployée. Toute évolution ultérieure
-- passe par un nouveau fichier numéroté (002, 003…).
-- =====================================================================

-- =====================================================================
-- Console logistique Kadesh — schéma SQLite
-- =====================================================================
-- Principe directeur : l'API darkstat est la SEULE source de vérité pour
-- les quantités en soute. Les livraisons des pilotes ne réécrivent jamais
-- un stock : elles créent une ligne dans stock_adjustments qui se superpose
-- au dernier relevé, puis devient caduque dès que l'API confirme.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilisateurs (identité fournie par Discord)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id    TEXT    NOT NULL UNIQUE,
  username      TEXT    NOT NULL,
  display_name  TEXT,
  avatar        TEXT,
  callsign      TEXT,                        -- nom du pilote en jeu
  role          TEXT    NOT NULL DEFAULT 'member'
                CHECK (role IN ('member','officer','admin')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id);

-- ---------------------------------------------------------------------
-- Stations (bases joueur)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,     -- nom affiché
  api_name      TEXT    NOT NULL UNIQUE,     -- doit correspondre à pobs[].name
  code          TEXT    NOT NULL UNIQUE,     -- désignateur court : KOC, SPC…
  system        TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- État vital de la station, écrasé à chaque synchronisation
CREATE TABLE IF NOT EXISTS station_status (
  station_id    INTEGER PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  money         INTEGER,
  health        REAL,
  cargospace    INTEGER,
  cargo_used    INTEGER,
  synced_at     TEXT
);

-- ---------------------------------------------------------------------
-- Marchandises
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,     -- nom lisible, aligné sur l'API
  commodity_id  TEXT,                        -- nickname interne (recettes .cfg)
  category      TEXT    NOT NULL DEFAULT 'commodity',
  vendor_hint   TEXT,                        -- « où en acheter »
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_commodity ON items(commodity_id);

-- ---------------------------------------------------------------------
-- Relevé de stock : une ligne par (station, marchandise), écrasée à chaque sync
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_snapshots (
  station_id    INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
  quantity      INTEGER NOT NULL DEFAULT 0,
  min_stock     INTEGER NOT NULL DEFAULT 0,
  max_stock     INTEGER NOT NULL DEFAULT 0,
  price         INTEGER,
  is_selling    INTEGER NOT NULL DEFAULT 0,
  synced_at     TEXT    NOT NULL,
  PRIMARY KEY (station_id, item_id)
);

-- ---------------------------------------------------------------------
-- Mouvements déclarés par les pilotes.
-- Un mouvement ne compte que s'il est POSTÉRIEUR au dernier relevé de sa
-- station : au-delà, l'API a déjà intégré la livraison.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id    INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
  delta         INTEGER NOT NULL,            -- positif = livré, négatif = retiré
  source        TEXT    NOT NULL DEFAULT 'mission'
                CHECK (source IN ('mission','manual','correction')),
  claim_id      INTEGER REFERENCES mission_claims(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_adj_lookup ON stock_adjustments(station_id, item_id, created_at);

-- ---------------------------------------------------------------------
-- Routes commerciales : d'où vient quoi, et pour qui
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id     INTEGER REFERENCES stations(id) ON DELETE CASCADE,
  dest_id       INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  source_label  TEXT,                        -- origine hors-faction (PNJ, autre base)
  priority      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, source_id, dest_id, source_label)
);

-- ---------------------------------------------------------------------
-- Recettes de fabrication (armurerie)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  category      TEXT    NOT NULL DEFAULT 'weapon',
  station_id    INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_components (
  recipe_id     INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  quantity      INTEGER NOT NULL,
  PRIMARY KEY (recipe_id, item_id)
);

-- ---------------------------------------------------------------------
-- Missions : besoins ouverts, réservables par plusieurs pilotes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS missions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id    INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
  direction     TEXT    NOT NULL CHECK (direction IN ('import','export')),
  target_qty    INTEGER NOT NULL DEFAULT 0,
  origin        TEXT,                        -- texte libre : où charger
  priority      TEXT    NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low','normal','high','critical')),
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','fulfilled','archived')),
  auto          INTEGER NOT NULL DEFAULT 0,  -- 1 = générée par le seuil min_stock
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_missions_open ON missions(status, station_id);

-- Une seule mission OUVERTE par station/marchandise/sens. Les missions closes
-- s'accumulent librement : c'est l'historique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_open_unique
  ON missions(station_id, item_id, direction) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS mission_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id    INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status        TEXT    NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress','delivered','abandoned','expired')),
  pledged_qty   INTEGER NOT NULL DEFAULT 0,
  delivered_qty INTEGER NOT NULL DEFAULT 0,
  claimed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_unique
  ON mission_claims(mission_id, user_id) WHERE status = 'in_progress';

-- ---------------------------------------------------------------------
-- Journalisation
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  status        TEXT    NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','ok','partial','error')),
  stations_seen INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  entity        TEXT,
  entity_id     INTEGER,
  detail        TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(created_at DESC);

-- ---------------------------------------------------------------------
-- Réglages modifiables depuis l'interface d'administration
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Vue : stock effectif = dernier relevé + livraisons postérieures
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_effective_stock;
CREATE VIEW v_effective_stock AS
SELECT
  s.station_id,
  s.item_id,
  s.quantity AS confirmed_qty,
  COALESCE((
    SELECT SUM(a.delta)
    FROM stock_adjustments a
    WHERE a.station_id = s.station_id
      AND a.item_id    = s.item_id
      AND a.created_at > s.synced_at
  ), 0) AS pending_qty,
  s.quantity + COALESCE((
    SELECT SUM(a.delta)
    FROM stock_adjustments a
    WHERE a.station_id = s.station_id
      AND a.item_id    = s.item_id
      AND a.created_at > s.synced_at
  ), 0) AS effective_qty,
  s.min_stock,
  s.max_stock,
  s.synced_at
FROM stock_snapshots s;
