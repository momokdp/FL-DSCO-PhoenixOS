-- =====================================================================
-- 006 — Volumes arrondis
--
-- darkstat sert les volumes en flottants 32 bits : 0,2 devient
-- 0,20000000298023224 une fois élargi en 64 bits. La valeur est juste au
-- millionième près, mais illisible, et elle se propageait dans le calcul
-- des points.
--
-- Six décimales suffisent très largement pour un volume de cargaison.
-- =====================================================================

UPDATE items SET volume = ROUND(volume, 6) WHERE volume IS NOT NULL;
