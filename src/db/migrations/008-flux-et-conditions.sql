-- =====================================================================
-- 008 — Sens conditionnel et missions liées
--
-- Deux besoins nouveaux :
--
--  * Certaines marchandises circulent dans les deux sens selon le niveau :
--    on en apporte quand la soute est basse, on en retire quand elle
--    déborde. Une case « à enlever » ne suffisait plus.
--
--  * Certaines missions n'ont de sens que si une AUTRE marchandise est
--    dans un état donné. Le Chiromaterial ne se produit qu'à partir du
--    Chirodebris : rappeler de faire tourner le module n'a d'intérêt que
--    lorsque le Chirodebris est plein.
-- =====================================================================

-- 'import', 'export' ou 'both'. NULL reprend l'ancienne case à cocher,
-- pour ne rien changer aux réglages déjà en place.
ALTER TABLE stock_thresholds ADD COLUMN flow_mode TEXT
  CHECK (flow_mode IN ('import','export','both'));

-- Marchandise dont l'état conditionne l'ouverture de cette mission.
ALTER TABLE stock_thresholds ADD COLUMN gate_item_id INTEGER
  REFERENCES items(id) ON DELETE SET NULL;

-- État attendu de cette marchandise : 'low' sous son seuil bas,
-- 'full' à son plafond ou au-dessus.
ALTER TABLE stock_thresholds ADD COLUMN gate_state TEXT
  CHECK (gate_state IN ('low','full'));

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

  -- Le mode explicite prime ; sinon on relit l'ancienne case à cocher.
  COALESCE(t.flow_mode,
           CASE WHEN COALESCE(t.is_export, 0) = 1 THEN 'export' ELSE 'import' END
  ) AS flow_mode,

  t.gate_item_id AS gate_item_id,
  t.gate_state   AS gate_state,

  CASE WHEN t.min_stock IS NOT NULL OR t.max_stock IS NOT NULL
       THEN 1 ELSE 0 END AS has_custom,

  s.synced_at
FROM stock_snapshots s
LEFT JOIN stock_thresholds t
  ON t.station_id = s.station_id AND t.item_id = s.item_id;

-- ---------------------------------------------------------------------
-- Niveau d'une marchandise, isolé pour servir de condition.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_item_level;
CREATE VIEW v_item_level AS
SELECT
  station_id,
  item_id,
  effective_qty,
  min_stock,
  max_stock,
  CASE
    WHEN min_stock > 0 AND effective_qty <  min_stock THEN 'low'
    WHEN max_stock > 0 AND effective_qty >= max_stock THEN 'full'
    ELSE 'ok'
  END AS level
FROM v_effective_stock;
