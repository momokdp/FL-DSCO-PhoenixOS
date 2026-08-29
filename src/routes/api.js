import express from 'express';
import { db } from '../db/index.js';
import { requireAuth, publicUser } from '../auth/middleware.js';
import { listStations, stationInventory, itemAcrossStations, syncState } from '../services/stock.js';
import {
  listOpenMissions, claimMission, deliverClaim, abandonClaim,
  myClaims, leaderboard, refreshAutoMissions, claimHistory, cancelDelivery,
} from '../services/missions.js';
import { subscribe, broadcast } from '../services/events.js';

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
apiRouter.get('/missions', requireAuth, (req, res) => {
  refreshAutoMissions();
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
  const result = claimMission(Number(req.params.id), req.user.id, req.body?.pledged);
  res.status(result.ok ? 200 : 409).json(result);
});

apiRouter.post('/claims/:id/deliver', requireAuth, (req, res) => {
  const result = deliverClaim(Number(req.params.id), req.user.id, req.body?.quantity, req.body?.note);
  res.status(result.ok ? 200 : 409).json(result);
});

apiRouter.post('/claims/:id/abandon', requireAuth, (req, res) => {
  const result = abandonClaim(Number(req.params.id), req.user.id);
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
    SELECT r.id, r.priority, r.source_label,
           i.name AS item_name, i.id AS item_id,
           src.name AS source_name, src.code AS source_code,
           dst.name AS dest_name,  dst.code AS dest_code, dst.id AS dest_id
    FROM routes r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN stations src ON src.id = r.source_id
    JOIN stations dst ON dst.id = r.dest_id
    WHERE r.active = 1
    ORDER BY dst.sort_order, src.sort_order, i.name
  `).all());
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

apiRouter.get('/leaderboard', requireAuth, (req, res) => {
  res.json(leaderboard(Number(req.query.days) || 30));
});
