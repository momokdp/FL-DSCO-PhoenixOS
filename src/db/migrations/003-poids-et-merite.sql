-- =====================================================================
-- 003 — Poids des marchandises, missions d'export, points de mérite
--
-- Le classement comptait des unités transportées, ce qui désavantage les
-- marchandises volumineuses : un vaisseau de 5 000 de soute emporte 5 000
-- unités d'un bien de volume 1, mais seulement 2 500 d'un bien de volume 2,
-- pour le même effort et le même nombre d'allers-retours.
--
-- On compte donc désormais des points : quantité × volume unitaire, le tout
-- pondéré par une éventuelle prime de risque propre à la mission.
-- =====================================================================

-- Volume unitaire, tel que darkstat le renvoie dans shop_items.volume.
-- 1 par défaut : sans information, une unité vaut un point.
ALTER TABLE items ADD COLUMN volume REAL NOT NULL DEFAULT 1;

-- Prime de risque : multiplicateur appliqué aux points de la mission.
-- 1 = pas de prime. 1.5 = trajet dangereux payé moitié plus.
ALTER TABLE missions ADD COLUMN reward_multiplier REAL NOT NULL DEFAULT 1;

-- Points figés au moment de la livraison.
--
-- Indispensable : si l'on recalculait à l'affichage, un changement de volume
-- côté darkstat ou une prime ajustée après coup réécrirait rétroactivement
-- le classement des mois passés.
ALTER TABLE mission_claims ADD COLUMN points REAL NOT NULL DEFAULT 0;

-- Sens de la marchandise sur une station donnée.
--
-- Une station qui produit du minerai n'a pas besoin qu'on lui en apporte :
-- il faut au contraire venir l'enlever quand le stock dépasse le plafond.
ALTER TABLE stock_thresholds ADD COLUMN is_export INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- La vue reprend le sens de circulation, pour que la génération des
-- missions sache s'il faut approvisionner ou enlever.
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
  COALESCE(t.is_export, 0) AS is_export,
  CASE WHEN t.min_stock IS NOT NULL OR t.max_stock IS NOT NULL
       THEN 1 ELSE 0 END AS has_custom,

  s.synced_at
FROM stock_snapshots s
LEFT JOIN stock_thresholds t
  ON t.station_id = s.station_id AND t.item_id = s.item_id;
