-- =====================================================================
-- 012 — Index des engagements par mission
--
-- Le tableau des missions calcule, pour chaque mission ouverte, le tonnage
-- engagé et le tonnage déjà livré. Le seul index par mission ne couvrait
-- que les engagements en cours : la somme des livraisons parcourait toute
-- la table, une fois par mission affichée, et cette table ne fait que
-- grossir — chaque run y laisse une ligne.
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_claim_mission_status
  ON mission_claims(mission_id, status);
