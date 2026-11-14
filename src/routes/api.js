import express from 'express';
import { db } from '../db/index.js';
import { requireAuth, publicUser } from '../auth/middleware.js';
import { listStations, stationInventory, itemAcrossStations, syncState } from '../services/stock.js';
import {
  listOpenMissions, claimMission, deliverClaim, abandonClaim,
  myClaims, refreshAutoMissions, claimHistory, cancelDelivery, payoutPlan,
} from '../services/missions.js';
import { subscribe, broadcast } from '../services/events.js';
import { listLoops } from '../services/loops.js';
import {
  listShips, listModels, addShip, updateShip, activateShip, retireShip,
} from '../services/hangar.js';

export const apiRouter = express.Router();

const int = (v) => (v == null || v === '' ? null : Number(v));

apiRouter.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user), sync: syncState() });
});

apiRouter.get('/events', requireAuth, subscribe);

// ---------------------------------------------------------------- stations
apiRouter.get('/stations', requireAuth, (req, res) => {
  res.json(listStations());
});

apiRouter.get('/stations/:id/inventory', requireAuth, (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station inconnue.' });
  res.json({ station, inventory: stationInventory(station.id) });
});

// ---------------------------------------------------------------- missions
// Une lecture ne recalcule rien. Les missions automatiques sont refaites là
// où le stock ou les seuils changent — relevé, livraison, désengagement,
// réglage d'officier — et par le rappel périodique de `server.js`. Les
// recalculer ici ouvrait une transaction d'écriture à chaque rafraîchissement
// de chaque pilote, pour retrouver presque toujours le même résultat.
apiRouter.get('/missions', requireAuth, (req, res) => {
  res.json(listOpenMissions({
    stationId: int(req.query.station),
    direction: req.query.direction || null,
    userId: req.user.id,
  }));
});

apiRouter.get('/missions/mine', requireAuth, (req, res) => {
  res.json(myClaims(req.user.id));
});

apiRouter.post('/missions/:id/claim', requireAuth, (req, res) => {
  const result = claimMission(Number(req.params.id), req.user.id, req.body?.pledged,
    req.body?.shipId ?? null);
  res.status(result.ok ? 200 : 409).json(result);
});

apiRouter.post('/claims/:id/deliver', requireAuth, (req, res) => {
  const result = deliverClaim(Number(req.params.id), req.user.id, req.body?.quantity, req.body?.note);
  // La livraison déplace le stock : l'objectif des missions automatiques
  // de cette marchandise doit suivre avant la prochaine lecture.
  if (result.ok) refreshAutoMissions();
  res.status(result.ok ? 200 : 409).json(result);
});

apiRouter.post('/claims/:id/abandon', requireAuth, (req, res) => {
  const result = abandonClaim(Number(req.params.id), req.user.id);
  // Une mission automatique dont le besoin est comblé ne reste ouverte que
  // tant qu'un pilote y est engagé : son départ peut la clore.
  if (result.ok) refreshAutoMissions();
  res.status(result.ok ? 200 : 409).json(result);
});

// ---------------------------------------------------------------- recettes
apiRouter.get('/recipes', requireAuth, (req, res) => {
  const recipes = db.prepare(`
    SELECT r.id, r.name, r.category, r.notes, st.name AS station_name
    FROM recipes r LEFT JOIN stations st ON st.id = r.station_id
    WHERE r.active = 1 ORDER BY r.category, r.name
  `).all();

  const components = db.prepare(`
    SELECT rc.recipe_id, rc.quantity, i.id AS item_id, i.name, i.vendor_hint
    FROM recipe_components rc JOIN items i ON i.id = rc.item_id
    ORDER BY i.name
  `).all();

  const stations = listStations();
  const stockRows = db.prepare(`
    SELECT station_id, item_id, effective_qty FROM v_effective_stock
  `).all();

  const stock = new Map(stockRows.map(s => [`${s.station_id}:${s.item_id}`, s.effective_qty]));
  const byRecipe = new Map();

  for (const c of components) {
    if (!byRecipe.has(c.recipe_id)) byRecipe.set(c.recipe_id, []);
    byRecipe.get(c.recipe_id).push({
      itemId: c.item_id,
      name: c.name,
      quantity: c.quantity,
      vendorHint: c.vendor_hint,
      stocks: Object.fromEntries(
        stations.map(st => [st.code, stock.get(`${st.id}:${c.item_id}`) ?? 0])
      ),
    });
  }

  res.json({
    stations: stations.map(s => ({ id: s.id, code: s.code, name: s.name })),
    recipes: recipes.map(r => ({ ...r, components: byRecipe.get(r.id) || [] })),
  });
});

// ---------------------------------------------------------------- routes
apiRouter.get('/routes', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.priority, r.source_label, r.auto, r.direction,
           r.faction_name, r.system_name, r.sector_coord, r.price, r.computed_at,
           i.name AS item_name, i.id AS item_id,
           src.name AS source_name, src.code AS source_code,
           dst.name AS dest_name,  dst.code AS dest_code, dst.id AS dest_id
    FROM routes r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN stations src ON src.id = r.source_id
    JOIN stations dst ON dst.id = r.dest_id
    WHERE r.active = 1
    ORDER BY r.auto, dst.sort_order, i.name
  `).all());
});

// ----------------------------------------------------- boucles de trade
//
// Les circuits sont calculés à l'heure par le worker ; cet appel ne fait
// que les mettre à l'échelle du vaisseau du pilote. Aucun appel à darkstat
// n'a lieu ici : un pilote qui ouvre l'écran ne doit pas attendre le
// réseau, et n'a aucune raison de déclencher une charge sortante.

apiRouter.get('/loops', requireAuth, (req, res) => {
  res.json(listLoops({
    user: req.user,
    stationId: int(req.query.station),
    // Le pilote peut simuler une autre cale sans toucher à son profil.
    cargo: int(req.query.cargo),
    shipClass: req.query.ship || null,
    // Un vaisseau du hangar : sa classe décide du volume de certaines
    // marchandises, ce qu'une cale saisie à la main ne peut pas dire.
    shipId: int(req.query.shipId),
  }));
});

// ------------------------------------------------------------- hangar
//
// Chaque pilote ne voit et ne touche que ses propres vaisseaux : toutes
// ces routes partent de req.user.id, jamais d'un identifiant de pilote
// reçu du client.

const repondre = (res, result, echec = 400) =>
  res.status(result.ok ? 200 : echec).json(result);

apiRouter.get('/me/ships', requireAuth, (req, res) => {
  res.json(listShips(req.user.id));
});

/** Le catalogue des modèles, tel que relevé sur darkstat. */
apiRouter.get('/ships/models', requireAuth, (_req, res) => {
  res.json(listModels());
});

apiRouter.post('/me/ships', requireAuth, (req, res) => {
  repondre(res, addShip(req.user.id, { model: req.body?.model, name: req.body?.name }));
});

apiRouter.put('/me/ships/:id', requireAuth, (req, res) => {
  repondre(res, updateShip(req.user.id, Number(req.params.id),
    { model: req.body?.model, name: req.body?.name }));
});

apiRouter.post('/me/ships/:id/activate', requireAuth, (req, res) => {
  repondre(res, activateShip(req.user.id, Number(req.params.id)));
});

apiRouter.delete('/me/ships/:id', requireAuth, (req, res) => {
  repondre(res, retireShip(req.user.id, Number(req.params.id)), 409);
});

// ---------------------------------------------------------------- divers
apiRouter.get('/items/:id/stock', requireAuth, (req, res) => {
  res.json(itemAcrossStations(Number(req.params.id)));
});

// ------------------------------------------------------------ historique

apiRouter.get('/missions/history', requireAuth, (req, res) => {
  res.json(claimHistory(req.user.id));
});

/**
 * Annulation d'une livraison : un pilote retire les siennes, un officier
 * peut corriger celles de n'importe qui.
 */
apiRouter.post('/claims/:id/cancel', requireAuth, (req, res) => {
  const isOfficer = req.user.role === 'officer' || req.user.role === 'admin';
  const result = cancelDelivery(Number(req.params.id), req.user.id, {
    isOfficer,
    reason: (req.body && req.body.reason) || null,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  broadcast('stock:updated', {});
  broadcast('missions:changed', {});
  res.json(result);
});

/**
 * Classement, cagnotte et répartition en un seul appel.
 *
 * Les trois se lisent ensemble : un pourcentage de participation n'a de
 * sens qu'en face des points qui le produisent, et une part en crédits
 * qu'en face de la cagnotte dont elle sort. Les servir séparément
 * laisserait l'écran afficher un instant une part calculée sur des fonds
 * qui ne sont plus ceux du relevé courant.
 */
apiRouter.get('/leaderboard', requireAuth, (req, res) => {
  const period = ['month', 'last', 'year'].includes(req.query.period) ? req.query.period : 'month';
  res.json({ period, ...payoutPlan(period) });
});
