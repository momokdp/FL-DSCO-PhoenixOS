import { config } from '../config.js';
import { db } from '../db/index.js';

/**
 * Reprend la logique de votre script Apps Script : le .cfg décrit chaque
 * recette par un bloc contenant infotext (nom lisible), produced_item
 * (identifiant interne) et une suite de lignes consumed (composants).
 * La correspondance produced_item → infotext sert à afficher des noms
 * lisibles à la place des identifiants bruts.
 */
export async function importRecipesFromConfig({ replace = false } = {}) {
  const res = await fetch(config.recipeSourceUrl, {
    headers: { 'User-Agent': 'KadeshConsole/1.0' },
  });
  if (!res.ok) throw new Error(`le serveur a répondu HTTP ${res.status}`);

  const text = await res.text();
  const { recipes, labels } = parseConfig(text);
  if (!recipes.length) throw new Error('aucune recette exploitable dans le fichier');

  return apply({ recipes, labels, replace });
}

function parseConfig(content) {
  const blocks = content.split(/\[\w+\]/);
  const labels = new Map();   // produced_item → nom lisible
  const recipes = [];

  for (const block of blocks) {
    const info = block.match(/infotext\s*=\s*([^,\r\n]+)/);
    const produced = block.match(/produced_item\s*=\s*([^,\r\n]+)/);
    if (info && produced) {
      labels.set(produced[1].trim().split(',')[0].trim(), info[1].trim());
    }
  }

  for (const block of blocks) {
    const info = block.match(/infotext\s*=\s*([^,\r\n]+)/);
    const produced = block.match(/produced_item\s*=\s*([^,\r\n]+)/);
    if (!info || !produced) continue;

    const name = info[1].trim();
    if (name.length < 2) continue;

    const components = [];
    const re = /consumed\s*=\s*([^,\r\n]+),\s*(\d+)/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const id = m[1].trim();
      const qty = parseInt(m[2], 10);
      if (id && qty > 0) components.push({ commodityId: id, quantity: qty });
    }

    if (components.length) recipes.push({ name, components });
  }

  return { recipes, labels };
}

const apply = db.transaction(({ recipes, labels, replace }) => {
  if (replace) db.prepare("DELETE FROM recipes WHERE category = 'weapon'").run();

  const findByCommodity = db.prepare('SELECT id FROM items WHERE commodity_id = ?');
  const findByName = db.prepare('SELECT id FROM items WHERE name = ? COLLATE NOCASE');
  const insertItem = db.prepare('INSERT INTO items (name, commodity_id) VALUES (?, ?)');
  const tagCommodity = db.prepare('UPDATE items SET commodity_id = ? WHERE id = ? AND commodity_id IS NULL');

  const upsertRecipe = db.prepare(`
    INSERT INTO recipes (name, category) VALUES (?, 'weapon')
    ON CONFLICT(name) DO UPDATE SET active = 1
  `);
  const clearComponents = db.prepare('DELETE FROM recipe_components WHERE recipe_id = ?');
  const addComponent = db.prepare(`
    INSERT INTO recipe_components (recipe_id, item_id, quantity) VALUES (?, ?, ?)
    ON CONFLICT(recipe_id, item_id) DO UPDATE SET quantity = excluded.quantity
  `);

  let itemsCreated = 0;

  const resolveItem = (commodityId) => {
    const byId = findByCommodity.get(commodityId);
    if (byId) return byId.id;

    // Le nom lisible du .cfg est aussi celui renvoyé par darkstat :
    // on rattache le composant à la marchandise déjà connue si elle existe.
    const readable = labels.get(commodityId) || commodityId;
    const byName = findByName.get(readable);
    if (byName) { tagCommodity.run(commodityId, byName.id); return byName.id; }

    itemsCreated++;
    return insertItem.run(readable, commodityId).lastInsertRowid;
  };

  for (const recipe of recipes) {
    upsertRecipe.run(recipe.name);
    const row = db.prepare('SELECT id FROM recipes WHERE name = ?').get(recipe.name);
    clearComponents.run(row.id);
    for (const c of recipe.components) {
      addComponent.run(row.id, resolveItem(c.commodityId), c.quantity);
    }
  }

  return { recipes: recipes.length, itemsCreated, replaced: replace };
});
