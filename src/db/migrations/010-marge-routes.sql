-- =====================================================================
-- 010 — Marge des routes
--
-- Cette colonne aurait dû figurer dans la migration 009, mais celle-ci
-- était déjà appliquée en production : la modifier n'avait aucun effet,
-- et le calcul des routes échouait sur « no column named margin ».
--
-- Rappel : une migration déjà déployée ne se retouche jamais. Toute
-- correction passe par un nouveau fichier.
-- =====================================================================

ALTER TABLE routes ADD COLUMN margin REAL;
