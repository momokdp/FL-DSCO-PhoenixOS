import express from 'express';
import { db, audit, nowSql, getSetting, setSetting } from '../db/index.js';
import { requireRole } from '../auth/middleware.js';
import { syncNow, isSyncRunning } from '../sync/darkstat.js';
import { broadcast } from '../services/events.js';
import { importRecipesFromConfig } from '../services/recipeImport.js';
import { config } from '../config.js';
import { setThreshold, listThresholds, stationInventory } from '../services/stock.js';

export const adminRouter = express.Router();

const officer = requireRole('officer');
const admin = requireRole('admin');

const str = (v) => (v == null ? null : String(v).trim() || null);
const num = (v) => (v == null || v === '' ? null : Number(v));
const bool = (v) => (v ? 1 : 0);

function ok(res, payload = {}) { res.json({ ok: true, ...payload }); }
function fail(res, code, error) { res.status(code).json({ ok: false, error }); }

/** Retrouve ou crée une marchandise à partir de son nom. */
function itemIdByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const found = db.prepare('SELECT id FROM items WHERE name = ? COLLATE NOCASE').get(clean);
  if (found) return found.id;
  return db.prepare('INSERT INTO items (name) VALUES (?)').run(clean).lastInsertRowid;
}

// ===================================================================
// Stations
// ===================================================================
adminRouter.get('/stations', officer, (req, res) => {
  res.json(db.prepare(`
    SELECT st.*, ss.synced_at, ss.money, ss.health
    FROM stations st LEFT JOIN station_status ss ON ss.station_id = st.id
    ORDER BY st.sort_order, st.name
  `).all());
});

adminRouter.post('/stations', officer, (req, res) => {
  const { name, api_name, code, system, sort_order, active } = req.body || {};
  if (!name || !api_name || !code) {
    return fail(res, 400, 'Le nom, le nom API et le code sont obligatoires.');
  }
  try {
    const info = db.prepare(`
      INSERT INTO stations (name, api_name, code, system, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(str(name), str(api_name), str(code).toUpperCase(), str(system), num(sort_order) ?? 0, bool(active ?? 1));
    audit(req.user.id, 'station.created', 'stations', info.lastInsertRowid, { name });
    broadcast('stations:changed', {});
    ok(res, { id: info.lastInsertRowid });
  } catch (e) {
    fail(res, 409, `Une station porte déjà ce nom, ce nom API ou ce code.`);
  }
});

adminRouter.put('/stations/:id', officer, (req, res) => {
  const { name, api_name, code, system, sort_order, active } = req.body || {};
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!existing) return fail(res, 404, 'Station inconnue.');
  try {
    db.prepare(`
      UPDATE stations SET name = ?, api_name = ?, code = ?, system = ?, sort_order = ?, active = ?
      WHERE id = ?
    `).run(
      str(name) ?? existing.name,
      str(api_name) ?? existing.api_name,
      (str(code) ?? existing.code).toUpperCase(),
      str(system),
      num(sort_order) ?? existing.sort_order,
      bool(active ?? existing.active),
      existing.id
    );
    audit(req.user.id, 'station.updated', 'stations', existing.id);
    broadcast('stations:changed', {});
    ok(res);
  } catch (e) {
    fail(res, 409, 'Ce nom, ce nom API ou ce code est déjà pris.');
  }
});

adminRouter.delete('/stations/:id', admin, (req, res) => {
  const info = db.prepare('DELETE FROM stations WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Station inconnue.');
  audit(req.user.id, 'station.deleted', 'stations', Number(req.params.id));
  broadcast('stations:changed', {});
  ok(res);
});

// ===================================================================
// Marchandises
// ===================================================================
adminRouter.get('/items', officer, (req, res) => {
  const q = str(req.query.q);
  const rows = q
    ? db.prepare(`SELECT * FROM items WHERE name LIKE ? ORDER BY name LIMIT 300`).all(`%${q}%`)
    : db.prepare(`SELECT * FROM items ORDER BY name LIMIT 300`).all();
  res.json(rows);
});

adminRouter.post('/items', officer, (req, res) => {
  const { name, commodity_id, category, vendor_hint } = req.body || {};
  if (!name) return fail(res, 400, 'Le nom de la marchandise est obligatoire.');
  try {
    const info = db.prepare(`
      INSERT INTO items (name, commodity_id, category, vendor_hint) VALUES (?, ?, ?, ?)
    `).run(str(name), str(commodity_id), str(category) || 'commodity', str(vendor_hint));
    audit(req.user.id, 'item.created', 'items', info.lastInsertRowid, { name });
    ok(res, { id: info.lastInsertRowid });
  } catch (e) {
    fail(res, 409, 'Cette marchandise existe déjà.');
  }
});

adminRouter.put('/items/:id', officer, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return fail(res, 404, 'Marchandise inconnue.');
  const { name, commodity_id, category, vendor_hint } = req.body || {};
  db.prepare(`
    UPDATE items SET name = ?, commodity_id = ?, category = ?, vendor_hint = ? WHERE id = ?
  `).run(
    str(name) ?? existing.name,
    str(commodity_id),
    str(category) || existing.category,
    str(vendor_hint),
    existing.id
  );
  audit(req.user.id, 'item.updated', 'items', existing.id);
  ok(res);
});

adminRouter.delete('/items/:id', admin, (req, res) => {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Marchandise inconnue.');
  audit(req.user.id, 'item.deleted', 'items', Number(req.params.id));
  ok(res);
});

// ===================================================================
// Routes commerciales
// ===================================================================
adminRouter.get('/routes', officer, (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, i.name AS item_name, src.name AS source_name, dst.name AS dest_name
    FROM routes r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN stations src ON src.id = r.source_id
    JOIN stations dst ON dst.id = r.dest_id
    ORDER BY dst.sort_order, i.name
  `).all());
});

adminRouter.post('/routes', officer, (req, res) => {
  const { item_name, source_id, dest_id, source_label, priority, active } = req.body || {};
  const itemId = itemIdByName(item_name);
  if (!itemId) return fail(res, 400, 'Indiquez la marchandise transportée.');
  if (!dest_id) return fail(res, 400, 'Indiquez la station de destination.');
  try {
    const info = db.prepare(`
      INSERT INTO routes (item_id, source_id, dest_id, source_label, priority, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(itemId, num(source_id), num(dest_id), str(source_label), num(priority) ?? 0, bool(active ?? 1));
    audit(req.user.id, 'route.created', 'routes', info.lastInsertRowid);
    ok(res, { id: info.lastInsertRowid });
  } catch (e) {
    fail(res, 409, 'Cette route existe déjà.');
  }
});

adminRouter.delete('/routes/:id', officer, (req, res) => {
  const info = db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Route inconnue.');
  audit(req.user.id, 'route.deleted', 'routes', Number(req.params.id));
  ok(res);
});

// ===================================================================
// Recettes
// ===================================================================
adminRouter.get('/recipes', officer, (req, res) => {
  const recipes = db.prepare(`SELECT * FROM recipes ORDER BY name`).all();
  const comps = db.prepare(`
    SELECT rc.recipe_id, rc.quantity, i.id AS item_id, i.name
    FROM recipe_components rc JOIN items i ON i.id = rc.item_id ORDER BY i.name
  `).all();
  const byRecipe = new Map();
  for (const c of comps) {
    if (!byRecipe.has(c.recipe_id)) byRecipe.set(c.recipe_id, []);
    byRecipe.get(c.recipe_id).push(c);
  }
  res.json(recipes.map(r => ({ ...r, components: byRecipe.get(r.id) || [] })));
});

const saveRecipe = db.transaction((payload, userId, existingId = null) => {
  const { name, category, station_id, notes, components } = payload;
  let id = existingId;

  if (id) {
    db.prepare(`UPDATE recipes SET name=?, category=?, station_id=?, notes=? WHERE id=?`)
      .run(str(name), str(category) || 'weapon', num(station_id), str(notes), id);
    db.prepare('DELETE FROM recipe_components WHERE recipe_id = ?').run(id);
  } else {
    id = db.prepare(`INSERT INTO recipes (name, category, station_id, notes) VALUES (?, ?, ?, ?)`)
      .run(str(name), str(category) || 'weapon', num(station_id), str(notes)).lastInsertRowid;
  }

  const insert = db.prepare(`
    INSERT INTO recipe_components (recipe_id, item_id, quantity) VALUES (?, ?, ?)
    ON CONFLICT(recipe_id, item_id) DO UPDATE SET quantity = excluded.quantity
  `);
  for (const c of components || []) {
    const itemId = c.item_id || itemIdByName(c.name);
    const qty = Number(c.quantity) || 0;
    if (itemId && qty > 0) insert.run(id, itemId, qty);
  }

  audit(userId, existingId ? 'recipe.updated' : 'recipe.created', 'recipes', id, { name });
  return id;
});

adminRouter.post('/recipes', officer, (req, res) => {
  if (!req.body?.name) return fail(res, 400, 'Donnez un nom à la recette.');
  try {
    ok(res, { id: saveRecipe(req.body, req.user.id) });
  } catch (e) {
    fail(res, 409, 'Une recette porte déjà ce nom.');
  }
});

adminRouter.put('/recipes/:id', officer, (req, res) => {
  const existing = db.prepare('SELECT id FROM recipes WHERE id = ?').get(req.params.id);
  if (!existing) return fail(res, 404, 'Recette inconnue.');
  try {
    saveRecipe(req.body, req.user.id, existing.id);
    ok(res);
  } catch (e) {
    fail(res, 409, 'Une recette porte déjà ce nom.');
  }
});

adminRouter.delete('/recipes/:id', officer, (req, res) => {
  const info = db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Recette inconnue.');
  audit(req.user.id, 'recipe.deleted', 'recipes', Number(req.params.id));
  ok(res);
});

/** Importe les recettes depuis le .cfg public de Discovery. */
adminRouter.post('/recipes/import', admin, async (req, res) => {
  try {
    const result = await importRecipesFromConfig({ replace: !!req.body?.replace });
    audit(req.user.id, 'recipe.imported', null, null, result);
    ok(res, result);
  } catch (e) {
    fail(res, 502, `Import impossible : ${e.message}`);
  }
});

// ===================================================================
// Missions créées à la main
// ===================================================================
adminRouter.post('/missions', officer, (req, res) => {
  const { station_id, item_name, direction, target_qty, origin, priority,
          reward_multiplier } = req.body || {};
  const itemId = itemIdByName(item_name);
  if (!station_id || !itemId) return fail(res, 400, 'Station et marchandise sont obligatoires.');

  // Prime de risque : multiplicateur des points. Bornée pour éviter qu'une
  // saisie erronée ne fausse durablement le classement.
  const prime = Math.min(10, Math.max(0.1, Number(reward_multiplier) || 1));

  try {
    const info = db.prepare(`
      INSERT INTO missions (station_id, item_id, direction, target_qty, origin, priority, status, auto, reward_multiplier, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)
    `).run(
      num(station_id), itemId, direction === 'export' ? 'export' : 'import',
      num(target_qty) ?? 0, str(origin), str(priority) || 'normal', prime, req.user.id
    );
    audit(req.user.id, 'mission.created', 'missions', info.lastInsertRowid);
    broadcast('missions:changed', {});
    ok(res, { id: info.lastInsertRowid });
  } catch (e) {
    fail(res, 409, 'Une mission ouverte existe déjà pour cette station et cette marchandise.');
  }
});

adminRouter.delete('/missions/:id', officer, (req, res) => {
  const info = db.prepare(`
    UPDATE missions SET status='archived', closed_at=datetime('now') WHERE id = ? AND status = 'open'
  `).run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Mission introuvable ou déjà close.');
  audit(req.user.id, 'mission.archived', 'missions', Number(req.params.id));
  broadcast('missions:changed', {});
  ok(res);
});

/** Correction manuelle de stock, tracée comme telle. */
adminRouter.post('/stock/adjust', officer, (req, res) => {
  const { station_id, item_id, delta, note } = req.body || {};
  if (!station_id || !item_id || !delta) return fail(res, 400, 'Station, marchandise et écart sont obligatoires.');
  db.prepare(`
    INSERT INTO stock_adjustments (station_id, item_id, delta, source, user_id, note, created_at)
    VALUES (?, ?, ?, 'correction', ?, ?, ?)
  `).run(num(station_id), num(item_id), num(delta), req.user.id, str(note), nowSql());
  audit(req.user.id, 'stock.adjusted', 'stations', num(station_id), { item_id, delta });
  broadcast('stock:updated', { stationId: num(station_id) });
  ok(res);
});

// ===================================================================
// Utilisateurs
// ===================================================================
adminRouter.get('/users', admin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.discord_id, u.username, u.display_name, u.callsign, u.avatar,
           u.role, u.active, u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM stock_adjustments a WHERE a.user_id = u.id AND a.source='mission') AS runs
    FROM users u ORDER BY u.role DESC, u.display_name
  `).all());
});

adminRouter.put('/users/:id', admin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return fail(res, 404, 'Utilisateur inconnu.');

  const { role, active, callsign } = req.body || {};

  // Garde-fou : la console doit toujours conserver un administrateur actif.
  if (target.role === 'admin' && (role && role !== 'admin' || active === false)) {
    const others = db.prepare(`
      SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?
    `).get(target.id).n;
    if (others === 0) return fail(res, 409, 'Cet utilisateur est le dernier administrateur actif.');
  }

  db.prepare(`UPDATE users SET role = ?, active = ?, callsign = ? WHERE id = ?`).run(
    ['member', 'officer', 'admin'].includes(role) ? role : target.role,
    active === undefined ? target.active : bool(active),
    str(callsign) ?? target.callsign,
    target.id
  );
  audit(req.user.id, 'user.updated', 'users', target.id, { role, active });
  ok(res);
});

// ===================================================================
// Synchronisation et réglages
// ===================================================================
adminRouter.get('/sync/log', officer, (req, res) => {
  res.json(db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 50').all());
});

adminRouter.post('/sync/run', officer, async (req, res) => {
  if (isSyncRunning()) return fail(res, 409, 'Une synchronisation est déjà en cours.');
  const result = await syncNow({ trigger: `manuel:${req.user.username}` });
  audit(req.user.id, 'sync.triggered');
  res.json(result);
});

adminRouter.get('/settings', admin, (req, res) => {
  res.json({
    rows: db.prepare('SELECT * FROM settings ORDER BY key').all(),
    runtime: {
      darkstatUrl: config.darkstat.baseUrl + config.darkstat.pobsPath,
      syncIntervalMinutes: config.darkstat.intervalMs / 60000,
      recipeSourceUrl: config.recipeSourceUrl,
    },
  });
});

adminRouter.put('/settings/:key', admin, (req, res) => {
  setSetting(req.params.key, req.body?.value ?? '');
  audit(req.user.id, 'setting.updated', 'settings', null, { key: req.params.key });
  ok(res);
});

adminRouter.get('/audit', admin, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, u.display_name, u.avatar
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 200
  `).all());
});

// ------------------------------------------------------- seuils réglés
//
// Les seuils de l'API décrivent la configuration en jeu, qui sert souvent
// un autre but que le nôtre : un plafond démesuré laisse les joueurs
// extérieurs vendre sans limite. Ces réglages disent notre besoin réel.

adminRouter.get('/thresholds', officer, (req, res) => {
  res.json(listThresholds());
});

/** Inventaire d'une station, seuils API et réglés côte à côte. */
adminRouter.get('/stations/:id/thresholds', officer, (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station inconnue.' });
  res.json({ station, inventory: stationInventory(station.id) });
});

adminRouter.put('/stations/:id/thresholds/:itemId', officer, (req, res) => {
  const station = db.prepare('SELECT id, name FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station inconnue.' });

  const item = db.prepare('SELECT id, name FROM items WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Marchandise inconnue.' });

  const result = setThreshold({
    stationId: station.id,
    itemId: item.id,
    minStock: req.body.min_stock,
    maxStock: req.body.max_stock,
    note: req.body.note,
    isExport: req.body.is_export,
    isHidden: req.body.is_hidden,
    riskBonus: req.body.risk_bonus,
    origin: req.body.origin,
    destination: req.body.destination,
    flowMode: req.body.flow_mode,
    gateItemId: req.body.gate_item_id,
    gateState: req.body.gate_state,
    userId: req.user.id,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  audit(req.user.id, result.cleared ? 'threshold.clear' : 'threshold.set', 'item', item.id, {
    station: station.name, item: item.name,
    min: req.body.min_stock ?? null, max: req.body.max_stock ?? null,
  });

  // Les seuils pilotent l'ouverture automatique des missions : le tableau
  // des pilotes doit refléter le changement sans attendre le prochain relevé.
  broadcast('stock:updated', { station: station.id });
  broadcast('missions:changed', {});

  res.json({ ok: true, cleared: !!result.cleared });
});
