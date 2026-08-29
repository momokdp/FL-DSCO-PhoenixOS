-- =====================================================================
-- 002 — Seuils personnalisés par station et marchandise
--
-- L'API expose les seuils configurés en jeu, qui répondent à une autre
-- logique que la nôtre : un plafond à 999 999 999 sert à laisser les
-- joueurs extérieurs vendre librement, pas à décrire notre besoin réel.
--
-- Ces réglages vivent dans une table à part, jamais touchée par la
-- synchronisation. Stockés dans stock_snapshots, ils seraient écrasés à
-- chaque relevé.
-- =====================================================================

CREATE TABLE IF NOT EXISTS stock_thresholds (
  station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,

  -- NULL signifie « garder la valeur de l'API ». On peut donc n'ajuster
  -- que le plancher, ou que le plafond, sans toucher à l'autre.
  min_stock   REAL,
  max_stock   REAL,

  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (station_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_thresholds_station ON stock_thresholds(station_id);

-- ---------------------------------------------------------------------
-- La vue applique les seuils retenus et conserve ceux de l'API à côté,
-- pour que l'interface puisse montrer l'écart entre les deux.
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

  -- Seuils retenus : le réglage manuel l'emporte, sinon l'API.
  COALESCE(t.min_stock, s.min_stock) AS min_stock,
  COALESCE(t.max_stock, s.max_stock) AS max_stock,

  -- Valeurs brutes de l'API, pour affichage comparatif.
  s.min_stock AS api_min_stock,
  s.max_stock AS api_max_stock,

  -- Réglages manuels tels quels : NULL = non défini.
  t.min_stock AS custom_min_stock,
  t.max_stock AS custom_max_stock,
  t.note      AS threshold_note,
  CASE WHEN t.min_stock IS NOT NULL OR t.max_stock IS NOT NULL
       THEN 1 ELSE 0 END AS has_custom,

  s.synced_at
FROM stock_snapshots s
LEFT JOIN stock_thresholds t
  ON t.station_id = s.station_id AND t.item_id = s.item_id;
