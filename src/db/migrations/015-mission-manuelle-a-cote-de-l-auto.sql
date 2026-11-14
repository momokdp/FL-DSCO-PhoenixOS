-- =====================================================================
-- 015 — Une mission manuelle à côté de la mission automatique
--
-- L'index n'admettait qu'une mission ouverte par station, marchandise et
-- sens. Dès que le réapprovisionnement automatique en tenait une, un
-- officier ne pouvait plus ouvrir de mission exceptionnelle sur la même
-- marchandise : il devait retoucher la prime et la quantité du réglage
-- permanent, puis penser à les remettre.
--
-- L'unicité se joue désormais par nature de mission : une automatique et
-- une manuelle peuvent coexister, mais jamais deux de la même nature.
-- Aucune base existante ne peut violer le nouvel index, plus permissif
-- que l'ancien.
-- =====================================================================

DROP INDEX IF EXISTS idx_mission_open_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_open_unique
  ON missions(station_id, item_id, direction, auto) WHERE status = 'open';
