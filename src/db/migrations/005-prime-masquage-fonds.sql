-- =====================================================================
-- 005 — Prime par marchandise, masquage, suivi des fonds
--
-- Trois besoins distincts, mais tous portés par le réglage de seuils :
--   * certaines marchandises sont pénibles à obtenir (territoire pirate,
--     butin sur PNJ) et méritent une prime permanente, pas ponctuelle ;
--   * certaines ne se produisent que sur commande et n'ont rien à faire
--     dans le tableau des missions ;
--   * la répartition mensuelle des gains suppose de connaître l'évolution
--     des fonds des stations, que l'API ne donne qu'à l'instant présent.
-- =====================================================================

-- Prime attachée à la marchandise sur une station donnée. 1 = pas de prime.
-- Elle se cumule avec la prime ponctuelle d'une mission créée à la main.
ALTER TABLE stock_thresholds ADD COLUMN risk_bonus REAL NOT NULL DEFAULT 1;

-- Marchandise retirée du tableau des missions : aucune mission automatique
-- n'est ouverte, et celles qui existent sont closes.
ALTER TABLE stock_thresholds ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- Relevé quotidien des fonds.
--
-- L'API ne renvoie que le solde courant. Pour connaître ce qu'une station
-- a gagné sur le mois, il faut avoir gardé une trace. Une valeur par jour
-- et par station suffit et reste minuscule à l'échelle de l'année.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS station_funds_log (
  station_id   INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  day          TEXT    NOT NULL,           -- AAAA-MM-JJ
  money        REAL    NOT NULL DEFAULT 0,
  recorded_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (station_id, day)
);

CREATE INDEX IF NOT EXISTS idx_funds_day ON station_funds_log(day);

-- ---------------------------------------------------------------------
-- La vue reprend les deux nouveaux réglages.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_effective_stock;
CREATE VIEW v_effective_stock AS
SELECT
  s.station_id,
  s.item_id,
  s.quantity AS confirmed_qty,
  COALESCE((
    SELECT SUM(a.delta) FROM stock_adjustments a
    WHERE a.station_id = s.station_id AND a.item_id = s.item_id
      AND a.created_at > s.synced_at
  ), 0) AS pending_qty,
  s.quantity + COALESCE((
    SELECT SUM(a.delta) FROM stock_adjustments a
    WHERE a.station_id = s.station_id AND a.item_id = s.item_id
      AND a.created_at > s.synced_at
  ), 0) AS effective_qty,

  COALESCE(t.min_stock, s.min_stock) AS min_stock,
  COALESCE(t.max_stock, s.max_stock) AS max_stock,
  s.min_stock AS api_min_stock,
  s.max_stock AS api_max_stock,
  t.min_stock AS custom_min_stock,
  t.max_stock AS custom_max_stock,
  t.note      AS threshold_note,
  COALESCE(t.is_export,  0) AS is_export,
  COALESCE(t.is_hidden,  0) AS is_hidden,
  COALESCE(t.risk_bonus, 1) AS risk_bonus,
  CASE WHEN t.min_stock IS NOT NULL OR t.max_stock IS NOT NULL
       THEN 1 ELSE 0 END AS has_custom,

  s.synced_at
FROM stock_snapshots s
LEFT JOIN stock_thresholds t
  ON t.station_id = s.station_id AND t.item_id = s.item_id;
