-- =====================================================================
-- 007 — Origine et destination par marchandise
--
-- Un pilote qui prend une mission a besoin de savoir où aller. Jusqu'ici
-- seule une mission créée à la main pouvait porter une origine ; les
-- missions ouvertes automatiquement, qui sont la majorité, n'indiquaient
-- rien.
--
-- L'information tient à la marchandise et à la station, pas à la mission :
-- l'Iridium se charge toujours au même endroit. Elle se règle donc avec
-- les seuils, une fois pour toutes.
-- =====================================================================

-- Import : où charger la marchandise avant de l'apporter.
ALTER TABLE stock_thresholds ADD COLUMN origin TEXT;

-- Export : où l'emmener une fois enlevée de la station.
ALTER TABLE stock_thresholds ADD COLUMN destination TEXT;

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
  t.note        AS threshold_note,
  t.origin      AS origin,
  t.destination AS destination,
  COALESCE(t.is_export,  0) AS is_export,
  COALESCE(t.is_hidden,  0) AS is_hidden,
  COALESCE(t.risk_bonus, 1) AS risk_bonus,
  CASE WHEN t.min_stock IS NOT NULL OR t.max_stock IS NOT NULL
       THEN 1 ELSE 0 END AS has_custom,

  s.synced_at
FROM stock_snapshots s
LEFT JOIN stock_thresholds t
  ON t.station_id = s.station_id AND t.item_id = s.item_id;
