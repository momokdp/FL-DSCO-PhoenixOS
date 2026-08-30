import { config } from '../config.js';
import { db, nowSql, setSetting } from '../db/index.js';
import { broadcast } from '../services/events.js';

let timer = null;
let running = false;

/**
 * Interroge darkstat et réécrit les relevés de stock.
 * Ne touche jamais à stock_adjustments : les livraisons des pilotes
 * deviennent simplement caduques dès que leur horodatage est antérieur
 * au nouveau synced_at.
 */
export async function syncNow({ trigger = 'auto' } = {}) {
  if (running) return { skipped: true, reason: 'Une synchronisation est déjà en cours.' };
  running = true;

  const logId = db.prepare(`INSERT INTO sync_log (status, message) VALUES ('running', ?)`)
    .run(`déclenchée : ${trigger}`).lastInsertRowid;

  try {
    // Horodaté avant l'appel : les données décrivent l'état au début de la
    // requête. Stamper après ferait passer pour « déjà intégrées » les
    // livraisons déclarées pendant que darkstat répondait.
    const stamp = nowSql();
    const pobs = await fetchPobs();
    const result = writeSnapshots(pobs, stamp);

    db.prepare(`
      UPDATE sync_log
      SET finished_at = datetime('now'), status = ?, stations_seen = ?, rows_written = ?, message = ?
      WHERE id = ?
    `).run(
      result.missing.length ? 'partial' : 'ok',
      result.stationsSeen,
      result.rowsWritten,
      messageReleve(result),
      logId
    );

    setSetting('last_sync_at', nowSql());
    broadcast('stock:updated', { stations: result.stationsSeen, rows: result.rowsWritten });
    return { ok: true, ...result };

  } catch (err) {
    console.error('[sync] échec :', err.message);
    db.prepare(`
      UPDATE sync_log SET finished_at = datetime('now'), status = 'error', message = ? WHERE id = ?
    `).run(String(err.message).slice(0, 500), logId);
    broadcast('sync:error', { message: err.message });
    return { ok: false, error: err.message };

  } finally {
    running = false;
  }
}

async function fetchPobs() {
  const url = config.darkstat.baseUrl + config.darkstat.pobsPath;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), config.darkstat.timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'KadeshConsole/1.0' },
    });
    if (!res.ok) throw new Error(`darkstat a répondu HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Réponse inattendue : un tableau de bases était attendu.');
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`darkstat n’a pas répondu en ${config.darkstat.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Message du journal de relevé.
 *
 * Distinguer « introuvable » de « trouvée mais vide » est essentiel : le
 * premier cas vient d'un nom API erroné, le second d'une base réellement
 * sans stock ou d'une fiche que darkstat ne renseigne pas.
 */
function messageReleve({ missing, vides, stationsSeen, rowsWritten }) {
  const parts = [];
  if (missing.length) {
    parts.push(`Introuvables côté API (vérifiez le nom exact) : ${missing.join(', ')}`);
  }
  if (vides.length) {
    parts.push(`Trouvées mais sans aucune marchandise : ${vides.join(', ')}`);
  }
  if (!parts.length) {
    parts.push(`Relevé complet : ${stationsSeen} station(s), ${rowsWritten} ligne(s).`);
  }
  return parts.join(' — ');
}

/** Clé de rapprochement tolérante : casse et espaces multiples ignorés. */
function cle(valeur) {
  return String(valeur || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Indexe les bases par nom ET par nickname.
 *
 * darkstat renvoie toutes les bases du jeu, dont beaucoup de fiches vides
 * marquées « is_fallback_info ». Une simple Map laissait la dernière entrée
 * écraser les précédentes : une fiche vide pouvait ainsi remplacer la vraie
 * station. On ne remplace donc une entrée déjà indexée que si la nouvelle
 * porte réellement des données.
 */
function indexerBases(pobs) {
  const index = new Map();

  const renseignee = (p) => !p.is_fallback_info && extraireMarchandises(p).length > 0;

  const poser = (k, p) => {
    if (!k) return;
    const existante = index.get(k);
    if (!existante || (renseignee(p) && !renseignee(existante))) index.set(k, p);
  };

  for (const p of pobs) {
    poser(cle(p.name), p);
    poser(cle(p.nickname), p);
  }
  return index;
}

/**
 * Les marchandises arrivent tantôt dans « shop_items » (tableau), tantôt
 * dans « shop_items_map » (objet indexé). L'un des deux peut être null.
 */
function extraireMarchandises(pob) {
  if (Array.isArray(pob.shop_items)) return pob.shop_items;
  if (pob.shop_items_map && typeof pob.shop_items_map === 'object') {
    return Object.values(pob.shop_items_map);
  }
  return [];
}

function writeSnapshots(pobs, stamp = nowSql()) {
  const stations = db.prepare('SELECT id, api_name FROM stations WHERE active = 1').all();
  const index = indexerBases(pobs);

  const findItem = db.prepare('SELECT id, commodity_id, volume FROM items WHERE name = ? COLLATE NOCASE');
  const insertItem = db.prepare(
    'INSERT INTO items (name, commodity_id, category, volume) VALUES (?, ?, ?, ?)');
  // Les marchandises créées avant que l'API ne fournisse leur identifiant
  // restent orphelines : on le complète dès qu'il apparaît.
  const completerItem = db.prepare(
    'UPDATE items SET commodity_id = ? WHERE id = ? AND (commodity_id IS NULL OR commodity_id = \'\')');
  // Le volume unitaire sert au calcul des points : on le suit à chaque relevé.
  const majVolume = db.prepare('UPDATE items SET volume = ? WHERE id = ? AND volume <> ?');
  const upsertStock = db.prepare(`
    INSERT INTO stock_snapshots
      (station_id, item_id, quantity, min_stock, max_stock, price, is_selling, synced_at)
    VALUES (@station_id, @item_id, @quantity, @min_stock, @max_stock, @price, @is_selling, @synced_at)
    ON CONFLICT(station_id, item_id) DO UPDATE SET
      quantity   = excluded.quantity,
      min_stock  = excluded.min_stock,
      max_stock  = excluded.max_stock,
      price      = excluded.price,
      is_selling = excluded.is_selling,
      synced_at  = excluded.synced_at
  `);
  const upsertStatus = db.prepare(`
    INSERT INTO station_status (station_id, money, health, cargospace, cargo_used, synced_at)
    VALUES (@station_id, @money, @health, @cargospace, @cargo_used, @synced_at)
    ON CONFLICT(station_id) DO UPDATE SET
      money = excluded.money, health = excluded.health,
      cargospace = excluded.cargospace, cargo_used = excluded.cargo_used,
      synced_at = excluded.synced_at
  `);

  // Le système est fourni par l'API : inutile de le saisir à la main. On ne
  // remplit que les champs laissés vides, pour ne pas écraser une correction.
  const completerSysteme = db.prepare(
    'UPDATE stations SET system = ? WHERE id = ? AND (system IS NULL OR system = \'\')');

  const missing = [];   // station déclarée, aucune base correspondante
  const vides = [];     // base trouvée, mais sans aucune marchandise
  let stationsSeen = 0, rowsWritten = 0;

  const run = db.transaction(() => {
    for (const station of stations) {
      const pob = index.get(cle(station.api_name));
      if (!pob) { missing.push(station.api_name); continue; }
      stationsSeen++;

      // Un point par station et par jour : suffisant pour mesurer la
      // variation mensuelle des fonds, et négligeable en volume.
      if (pob.money != null) {
        db.prepare(`
          INSERT INTO station_funds_log (station_id, day, money)
          VALUES (?, date('now'), ?)
          ON CONFLICT(station_id, day) DO UPDATE SET
            money = excluded.money, recorded_at = datetime('now')
        `).run(station.id, Number(pob.money) || 0);
      }

      const systeme = String(pob.system_name || '').trim();
      if (systeme) completerSysteme.run(systeme, station.id);

      const shopItems = extraireMarchandises(pob);
      if (!shopItems.length) vides.push(station.api_name);
      let used = 0;

      for (const raw of shopItems) {
        // darkstat expose plusieurs variantes d'une même marchandise, dont
        // des doublons au nom suffixé « () » qui portent des volumes
        // différents (Military Salvage : 0,2 / 0,4 contre 1). On les fond
        // sous un seul nom, et seule la variante sans parenthèses fait
        // autorité sur le volume.
        const nomBrut = String(raw.name || '').trim();
        if (!nomBrut) continue;
        const variante = /\(\s*\)\s*$/.test(nomBrut);
        const name = nomBrut.replace(/\s*\(\s*\)\s*$/, '').trim();
        if (!name) continue;

        const nickname = String(raw.nickname || '').trim() || null;
        const categorie = String(raw.category || 'commodity').trim() || 'commodity';

        // darkstat expose le volume unitaire ; à défaut, une unité vaut 1.
        // darkstat sert des flottants 32 bits : 0,2 arrive en
        // 0,20000000298023224. On arrondit au millionième, bien au-delà de
        // la précision utile pour un volume de cargaison.
        const vol = Number(raw.volume ?? raw.original_volume);
        const volume = Number.isFinite(vol) && vol > 0
          ? Math.round(vol * 1e6) / 1e6
          : 1;

        let item = findItem.get(name);
        if (!item) {
          item = { id: insertItem.run(name, nickname, categorie, volume).lastInsertRowid };
        } else {
          if (nickname && !item.commodity_id) completerItem.run(nickname, item.id);
          // Une variante « () » ne doit pas écraser le volume de référence.
          if (!variante) majVolume.run(volume, item.id, volume);
        }

        const qty = Number(raw.quantity) || 0;
        used += qty;

        upsertStock.run({
          station_id: station.id,
          item_id: item.id,
          quantity: qty,
          min_stock: Number(raw.min_stock) || 0,
          max_stock: Number(raw.max_stock) || 0,
          price: raw.price != null ? Number(raw.price) : null,
          is_selling: raw.is_selling ? 1 : 0,
          synced_at: stamp,
        });
        rowsWritten++;
      }

      upsertStatus.run({
        station_id: station.id,
        money: Number(pob.money) || 0,
        health: Number(pob.health) || 0,
        cargospace: Number(pob.cargospace) || 0,
        cargo_used: used,
        synced_at: stamp,
      });
    }
  });

  run();
  return { stationsSeen, rowsWritten, missing, vides };
}

export function startSyncWorker() {
  if (timer) return;
  const every = config.darkstat.intervalMs;
  console.log(`[sync] worker actif — relevé toutes les ${every / 60000} min`);
  syncNow({ trigger: 'démarrage' });
  timer = setInterval(() => syncNow({ trigger: 'planifié' }), every);
}

export function stopSyncWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function isSyncRunning() { return running; }
