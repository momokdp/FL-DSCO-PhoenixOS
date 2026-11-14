/* =====================================================================
   Arsenal — recettes, modules des stations et file de production.

   Quatre volets sur les mêmes données :
     Commandes   ce que chaque client attend, et où en est chaque pièce
     À importer  ce que la file réclame et que nos soutes n'ont pas
     Recettes    le catalogue relevé sur darkstat, face à nos stocks
     Stations    quel module est posé où

   Le serveur donne tout en un appel ; le calcul (production-calc.js) se
   fait ici, pour que le brouillon d'une commande réponde à chaque chiffre.
   ===================================================================== */

import {
  h, get, post, put, del, api, num, dec, ago, toast, notifyError, modal, confirmDialog,
  field, input, select, empty, panel, clear,
} from './ui.js';
import { t, t2 } from './i18n.js';
import {
  plan, shopping, orderState, capacity, obstacles, stationsFor,
} from './production-calc.js';

const aPlat = (texte) => String(texte ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Les équipements se rangent ensemble : quatre familles suffisent à trier. */
const famille = (categorie) => (['gun', 'ship', 'commodity'].includes(categorie) ? categorie : 'equipment');

/** Durée d'une fabrication : des minutes aux jours, sans décimale inutile. */
function duree(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return t('prod.durM', { m });
  if (m < 1440) return t('prod.durH', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
  return t('prod.durD', { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60) });
}

export async function productionView(ctx) {
  const st = ctx.prod ||= {
    tab: 'orders', search: '', family: '', factory: '', ours: false, allNeeds: false,
    openRecipes: new Set(), openLines: new Set(),
  };

  const data = await get('/production');
  const outils = boite(ctx, data);

  const entete = h('div.head.head--row',
    h('div', h('span.eyebrow', t('prod.eyebrow')), h('h1', t('prod.title'))),
    data.recipes.length
      ? h('button.btn.btn--primary', { type: 'button', onClick: () => outils.commander() }, t('prod.newOrder'))
      : null,
  );

  if (!data.recipes.length) {
    return h('div', entete, empty(t('prod.noCatalog'), t('prod.noCatalogHint'),
      data.me.officer ? boutonReleve(ctx) : null));
  }

  const calc = plan(data);
  const aImporter = calc.shopping.filter((e) => e.missing > 0 || e.elsewhere > 0);
  const ouvertes = data.orders.filter((o) => o.status === 'open');

  const corps = h('div');
  const volets = {
    orders: { label: t('prod.tabOrders'), n: ouvertes.length, voir: () => voletCommandes(data, calc, outils, st) },
    needs: { label: t('prod.tabNeeds'), n: aImporter.length, voir: () => voletBesoins(data, calc, outils, st) },
    recipes: { label: t('prod.tabRecipes'), n: data.recipes.filter((r) => !r.retired).length, voir: () => voletRecettes(data, outils, st) },
    stations: { label: t('prod.tabStations'), n: null, voir: () => voletStations(data, outils, ctx) },
  };
  if (!volets[st.tab]) st.tab = 'orders';

  const onglets = h('div.tabs.prod-tabs');
  const montrer = () => {
    clear(onglets);
    for (const [cle, v] of Object.entries(volets)) {
      onglets.appendChild(h('button.chip', {
        type: 'button', class: st.tab === cle ? 'is-on' : null,
        onClick: () => { st.tab = cle; montrer(); },
      }, v.label, v.n != null ? h('b', ` ${num(v.n)}`) : null));
    }
    corps.replaceChildren(volets[st.tab].voir());
  };
  outils.aller = (tab, patch = {}) => { Object.assign(st, patch, { tab }); montrer(); };
  montrer();

  return h('div.prod', entete, indicateurs(calc, ouvertes, outils), onglets, corps);
}

/* ------------------------------------------------------- boîte à outils */

/** Ce que tous les volets partagent : noms, droits, actions. */
function boite(ctx, data) {
  const recettes = new Map(data.recipes.map((r) => [r.nick, r]));
  const stations = new Map(data.stations.map((s) => [s.id, s]));
  // Marchandise → recette qui la produit : un ingrédient fabricable se signale.
  const fabricables = new Map();
  for (const r of data.recipes) if (!r.retired && !fabricables.has(r.product)) fabricables.set(r.product, r);

  const nom = (nick) => data.names[nick]?.name
    || String(nick).replace(/^commodity_/, '').replace(/_/g, ' ');

  const agir = async (appel, message = null) => {
    try { await appel(); if (message) toast(message); ctx.reload(); } catch (e) { notifyError(e); }
  };

  const o = {
    ctx, data, recettes, stations, fabricables, nom, agir,
    peut: (ordre) => data.me.officer || ordre.createdBy === data.me.id,
    code: (id) => stations.get(Number(id))?.code || '—',
    commander: (opts = {}) => dialogueCommande(o, opts),
  };
  return o;
}

/** Marchandise nommée, avec son repère « fabricable » quand une recette la sort. */
function marchandise(o, nick, { catalyst = false, options = null } = {}) {
  const recette = o.fabricables.get(nick);
  return h('span.mat',
    h('strong', o.nom(nick)),
    catalyst ? h('span.tag.tag--auto', { title: t('prod.catalystHint') }, t('prod.catalyst')) : null,
    recette ? h('button.linkish', {
      type: 'button', title: t('prod.craftableHint'),
      onClick: () => o.aller('recipes', { search: recette.name, family: '', factory: '', ours: false }),
    }, t('prod.craftable')) : null,
    options && options.length > 1
      ? h('em.hint', t('prod.orAlt', { v: options.filter((x) => x.nick !== nick).map((x) => o.nom(x.nick)).join(', ') }))
      : null,
  );
}

/* --------------------------------------------------------- indicateurs */

function indicateurs(calc, ouvertes, o) {
  const enFile = calc.lines.filter((l) => l.line.status === 'queued');
  const enCours = calc.lines.filter((l) => l.line.status === 'running');
  const pretes = enFile.filter((l) => l.state === 'ready').length;
  const manquants = calc.shopping.filter((e) => e.missing > 0).length;
  const transferts = calc.shopping.filter((e) => !e.missing && e.elsewhere > 0).length;

  const kpi = (label, valeur, sous, ton, tab) => h('button.kpi', {
    type: 'button', class: ton ? `is-${ton}` : null, onClick: () => o.aller(tab),
  }, h('span', label), h('b', num(valeur)), h('i', sous));

  return h('div.prod-kpis',
    kpi(t('prod.kpiOrders'), ouvertes.length, t2('prod.kpiClients', new Set(ouvertes.map((x) => aPlat(x.client))).size), null, 'orders'),
    kpi(t('prod.kpiQueued'), enFile.length, t2('prod.kpiReady', pretes), pretes ? 'ok' : null, 'orders'),
    kpi(t('prod.kpiRunning'), enCours.length,
      enCours.length ? t('prod.kpiNextEnd', { v: duree(Math.min(...enCours.map((l) => l.remainingMinutes))) }) : t('prod.kpiIdle'),
      enCours.length ? 'run' : null, 'orders'),
    kpi(t('prod.kpiMissing'), manquants, t('prod.kpiTransfers', { n: num(transferts) }), manquants ? 'bad' : 'ok', 'needs'),
  );
}

/* ====================================================== volet commandes */

const ETATS = {
  ready: 'ok', transfer: 'move', short: 'bad', blocked: 'bad', running: 'run', done: 'off', empty: 'off',
};

const etiquette = (etat) => h('span.state', { class: `is-${ETATS[etat] || 'off'}` }, t(`prod.state.${etat}`));

function voletCommandes(data, calc, o, st) {
  const ouvertes = data.orders.filter((x) => x.status === 'open');
  const remises = data.orders.filter((x) => x.status === 'delivered').reverse();
  const out = h('div');

  const enCours = calc.lines.filter((l) => l.line.status === 'running');
  if (enCours.length) {
    out.appendChild(panel(t('prod.runningTitle'), { count: enCours.length, flush: true },
      h('div.runs', enCours.map((l) => ligneEnCours(l, o)))));
  }

  if (!ouvertes.length) {
    out.appendChild(empty(t('prod.noOrders'), t('prod.noOrdersHint'),
      h('button.btn.btn--steel', { type: 'button', onClick: () => o.commander() }, t('prod.newOrder'))));
  }
  for (const ordre of ouvertes) {
    out.appendChild(carteCommande(ordre, calc.lines.filter((l) => l.order === ordre), o, st));
  }

  if (remises.length) {
    out.appendChild(panel(t('prod.deliveredTitle'), { count: remises.length, flush: true },
      h('table.table', h('tbody', remises.map((ordre) => h('tr.is-off',
        h('td', h('strong', ordre.client)),
        h('td', ordre.lines.map((l) => `${num(l.quantity)} × ${l.name}`).join(' · ')),
        h('td', { class: 'num' }, t('common.ago', { v: ago(ordre.closedAt) })),
        h('td', { class: 'row-actions' }, o.peut(ordre) ? h('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          onClick: () => o.agir(() => post(`/production/orders/${ordre.id}/reopen`), t('prod.reopened')),
        }, t('prod.reopen')) : null),
      ))))));
  }
  return out;
}

/** Une fabrication lancée : sa barre, son échéance, et le bouton qui la clôt. */
function ligneEnCours(l, o) {
  const fini = l.progress >= 1;
  return h('div.run', { class: fini ? 'is-due' : null },
    h('div.run__what',
      h('strong', `${num(l.line.quantity)} × ${l.line.name}`),
      h('em.hint', `${l.order.client} · ${l.station?.name || '—'}`),
    ),
    h('div.progress', { role: 'img', 'aria-label': `${Math.round(l.progress * 100)} %` },
      h('span', { style: `width:${Math.round(l.progress * 100)}%` })),
    h('span.run__eta', fini ? t('prod.due') : t('prod.endsIn', { v: duree(l.remainingMinutes) })),
    o.peut(l.order) ? h('button.btn.btn--go.btn--sm', {
      type: 'button',
      onClick: () => o.agir(() => post(`/production/lines/${l.line.id}/status`, { status: 'done' }), t('prod.finished')),
    }, t('prod.finish')) : null,
  );
}

function carteCommande(ordre, lignes, o, st) {
  const etat = orderState(lignes);
  const peut = o.peut(ordre);
  const minutes = lignes.filter((l) => l.line.status !== 'done').reduce((a, l) => a + l.minutes, 0);
  const faites = lignes.filter((l) => l.line.status === 'done').length;

  const modifier = async () => {
    const client = input({ name: 'client', value: ordre.client, maxlength: '80' });
    const note = input({ name: 'note', value: ordre.note || '', maxlength: '400', placeholder: t('common.optional') });
    const v = await modal({
      title: t('prod.editOrder'),
      build: () => h('div', field(t('prod.client'), client), field(t('common.note'), note)),
      actions: [{ label: t('common.cancel'), value: null },
        { label: t('common.save'), variant: 'primary', onClick: (c) => c({ client: client.value, note: note.value }) }],
    });
    if (v) o.agir(() => put(`/production/orders/${ordre.id}`, v), t('prod.saved'));
  };

  const supprimer = async () => {
    if (!await confirmDialog(t('prod.deleteOrder'), t('prod.deleteOrderBody', { client: ordre.client }), t('common.delete'))) return;
    o.agir(() => del(`/production/orders/${ordre.id}`), t('prod.deleted'));
  };

  return h('article.order', { dataset: { state: ETATS[etat] || 'off' } },
    h('header.order__head',
      h('div.order__who',
        h('h3', ordre.client),
        h('span.hint', t('prod.orderMeta', { who: ordre.author || '—', v: ago(ordre.createdAt) })),
      ),
      etiquette(etat),
      h('span.order__count', t('prod.orderProgress', { done: faites, total: lignes.length })),
      minutes > 0 ? h('span.order__time', { title: t('prod.totalTime') }, duree(minutes)) : null,
      h('span.spacer'),
      peut ? h('div.order__tools',
        h('button.btn.btn--steel.btn--sm', { type: 'button', onClick: () => o.commander({ orderId: ordre.id }) }, t('prod.addLine')),
        etat === 'done' ? h('button.btn.btn--go.btn--sm', {
          type: 'button',
          onClick: () => o.agir(() => post(`/production/orders/${ordre.id}/deliver`), t('prod.delivered')),
        }, t('prod.deliver')) : null,
        h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: modifier }, t('common.edit')),
        h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: supprimer }, t('common.delete')),
      ) : null,
    ),
    ordre.note ? h('p.order__note', ordre.note) : null,
    lignes.length
      ? h('div.order__lines', lignes.map((l) => ligneCommande(l, peut, o, st)))
      : h('p.hint', { style: 'margin:0;padding:1rem 1.1rem' }, t('prod.emptyOrder')),
  );
}

function ligneCommande(l, peut, o, st) {
  const { line, recipe } = l;
  const statut = (status, extra = {}) => o.agir(() =>
    post(`/production/lines/${line.id}/status`, { status, ...extra }));

  const actions = h('div.oline__actions');
  if (peut && line.status === 'queued') {
    actions.append(
      h('button.btn.btn--go.btn--sm', {
        type: 'button', disabled: l.state === 'blocked' || !l.station,
        title: l.state === 'short' || l.state === 'transfer' ? t('prod.startAnyway') : null,
        onClick: () => statut('running', { stationId: l.station?.id }),
      }, t('prod.start')),
      h('button.btn.btn--ghost.btn--sm', {
        type: 'button', 'aria-label': t('prod.removeLine'), title: t('prod.removeLine'),
        onClick: () => o.agir(() => del(`/production/lines/${line.id}`)),
      }, '×'),
    );
  } else if (peut && line.status === 'running') {
    actions.append(
      h('button.btn.btn--go.btn--sm', { type: 'button', onClick: () => statut('done') }, t('prod.finish')),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => statut('queued') }, t('prod.requeue')),
    );
  } else if (peut && line.status === 'done') {
    actions.append(h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => statut('queued') }, t('prod.requeue')));
  }

  // La station se choisit tant que la fabrication n'est pas partie.
  const choixStation = peut && line.status === 'queued' && recipe
    ? select([{ value: '', label: l.station && !l.assigned ? t('prod.autoStation', { v: l.station.code }) : t('prod.pickStation') },
      ...o.data.stations.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))],
    { value: line.stationId ?? '', class: 'input--sm',
      'aria-label': t('prod.station'),
      onChange: (e) => o.agir(() => put(`/production/lines/${line.id}`, { stationId: e.target.value || null })) })
    : h('span.oline__station', l.station ? l.station.code : '—');

  const tete = h('div.oline__row',
    h('div.oline__what',
      h('strong', `${num(line.quantity)} × ${line.name}`),
      h('em.hint', recipe
        ? [recipe.factory || t('prod.noFactory'),
          l.runs > 1 || l.product?.qty > 1 ? t2('prod.runs', l.runs) : null,
          l.mult !== 1 ? t('prod.bonus', { v: dec(l.mult) }) : null].filter(Boolean).join(' · ')
        : t('prod.recipeGone')),
    ),
    choixStation,
    h('span.oline__time', recipe ? duree(l.minutes) : '—'),
    line.status === 'running'
      ? h('span.oline__state', h('div.progress', h('span', { style: `width:${Math.round(l.progress * 100)}%` })),
        h('em.hint', l.progress >= 1 ? t('prod.due') : t('prod.endsIn', { v: duree(l.remainingMinutes) })))
      : h('span.oline__state', etiquette(l.state)),
    actions,
  );

  const obstaclesLus = l.issues.map((i) => h('p.oline__issue', t(`prod.issue.${i}`, {
    station: l.station?.name || '', factory: recipe?.factory || '', level: recipe?.level ?? '',
  })));

  if (line.status !== 'queued' || !recipe) return h('div.oline', { dataset: { status: line.status } }, tete, obstaclesLus);

  const manquants = [...l.consumed, ...l.catalysts].filter((c) => c.missing > 0).length;
  const transferts = [...l.consumed, ...l.catalysts].filter((c) => !c.missing && c.elsewhere > 0).length;
  const resume = manquants ? t2('prod.matMissing', manquants)
    : transferts ? t2('prod.matTransfer', transferts) : t('prod.matReady');

  const detail = h('details.oline__mats', {
    open: st.openLines.has(line.id),
    onToggle: (e) => { if (e.target.open) st.openLines.add(line.id); else st.openLines.delete(line.id); },
  },
  h('summary', t('prod.materials'), h('span.hint', ` — ${resume}`)),
  tableBesoins(l, o),
  );

  return h('div.oline', { dataset: { status: line.status } }, tete, obstaclesLus, detail);
}

/** Besoins d'une fabrication, face aux soutes : requis, sur place, ailleurs, à importer. */
function tableBesoins(l, o) {
  const rang = (c, catalyst) => h('tr',
    h('td', marchandise(o, c.nick, { catalyst, options: c.options })),
    h('td', { class: 'num' }, num(c.need)),
    h('td', { class: `num ${c.onSite >= c.need ? 'is-ok' : ''}` }, num(c.onSite)),
    h('td', { class: `num ${c.elsewhere ? 'is-move' : ''}`,
      title: (c.from || []).map((f) => `${o.code(f.stationId)} ${num(f.qty)}`).join(' · ') || null },
    c.elsewhere ? num(c.elsewhere) : '—'),
    h('td', { class: `num ${c.missing ? 'is-empty' : 'is-ok'}` }, c.missing ? num(c.missing) : '✓'),
  );
  return h('table.table.table--mats',
    h('thead', h('tr',
      h('th', t('prod.colGoods')),
      h('th', { class: 'num' }, t('prod.colNeed')),
      h('th', { class: 'num' }, l.station ? t('prod.colOnSite', { v: l.station.code }) : t('prod.colOnSiteNone')),
      h('th', { class: 'num' }, t('prod.colElsewhere')),
      h('th', { class: 'num' }, t('prod.colImport')),
    )),
    h('tbody', l.consumed.map((c) => rang(c, false)), l.catalysts.map((c) => rang(c, true))),
  );
}

/* ====================================================== volet besoins */

function voletBesoins(data, calc, o, st) {
  const lignes = calc.shopping.filter((e) => st.allNeeds || e.missing > 0 || e.elsewhere > 0);

  const bascule = h('div.toolbar',
    h('div.tabs',
      h('button.chip', { type: 'button', class: st.allNeeds ? null : 'is-on',
        onClick: () => o.aller('needs', { allNeeds: false }) }, t('prod.needsOpen')),
      h('button.chip', { type: 'button', class: st.allNeeds ? 'is-on' : null,
        onClick: () => o.aller('needs', { allNeeds: true }) }, t('prod.needsAll')),
    ),
    h('em.hint', t('prod.needsHint')),
  );

  if (!calc.shopping.length) return h('div', empty(t('prod.needsNone'), t('prod.needsNoneHint')));
  if (!lignes.length) return h('div', bascule, empty(t('prod.needsCovered'), t('prod.needsCoveredHint')));

  const parStation = new Map();
  for (const e of lignes) {
    if (!parStation.has(e.stationId)) parStation.set(e.stationId, []);
    parStation.get(e.stationId).push(e);
  }

  const ouvrirMission = async (e, station) => {
    const qte = input({ type: 'number', min: '1', step: '1', value: e.missing, class: 'input--num' });
    const v = await modal({
      title: t('prod.missionTitle'),
      build: () => h('div',
        h('p', { style: 'margin-top:0' }, h('strong', o.nom(e.nick)), ` → ${station.name}`),
        field(t('prod.missionQty'), qte, t('prod.missionHint'))),
      actions: [{ label: t('common.cancel'), value: null },
        { label: t('prod.missionOpen'), variant: 'primary', onClick: (c) => c(Math.round(Number(qte.value) || 0)) }],
    });
    if (!(v > 0)) return;
    o.agir(() => post('/admin/missions', {
      station_id: station.id, item_id: data.items[e.nick], direction: 'import', target_qty: v, priority: 'high',
    }), t('prod.missionDone'));
  };

  const blocs = [...parStation.entries()].map(([stationId, liste]) => {
    const station = o.stations.get(stationId) || null;
    liste.sort((a, b) => b.missing - a.missing || b.elsewhere - a.elsewhere || o.nom(a.nick).localeCompare(o.nom(b.nick)));
    const manquants = liste.filter((e) => e.missing > 0).length;

    return panel(station ? station.name : t('prod.noStation'), {
      count: liste.length, flush: true,
      tools: manquants ? h('span.tag.is-low', t2('prod.matMissing', manquants)) : h('span.tag.is-ok', t('prod.nothingToImport')),
    },
    h('table.table.table--mats',
      h('thead', h('tr',
        h('th', t('prod.colGoods')), h('th', t('prod.colFor')),
        h('th', { class: 'num' }, t('prod.colNeed')),
        h('th', { class: 'num' }, t('prod.colOnSiteShort')),
        h('th', { class: 'num' }, t('prod.colElsewhere')),
        h('th', { class: 'num' }, t('prod.colImport')),
        h('th', ''),
      )),
      h('tbody', liste.map((e) => h('tr',
        h('td', marchandise(o, e.nick, { catalyst: e.catalyst })),
        h('td', h('em.hint', e.orders.join(', '))),
        h('td', { class: 'num' }, num(e.need)),
        h('td', { class: `num ${e.onSite >= e.need ? 'is-ok' : ''}` }, num(e.onSite)),
        h('td', { class: `num ${e.elsewhere ? 'is-move' : ''}` }, e.elsewhere ? num(e.elsewhere) : '—'),
        h('td', { class: `num ${e.missing ? 'is-empty' : 'is-ok'}` }, e.missing ? num(e.missing) : '✓'),
        h('td', { class: 'row-actions' },
          data.me.officer && station && e.missing > 0 && data.items[e.nick]
            ? h('button.btn.btn--steel.btn--sm', { type: 'button', onClick: () => ouvrirMission(e, station) }, t('prod.missionOpen'))
            : null),
      ))),
    ));
  });

  return h('div', bascule, blocs);
}

/* ===================================================== volet recettes */

function voletRecettes(data, o, st) {
  const pool = data.stock;
  const recettes = data.recipes.filter((r) => !r.retired);
  const usines = [...new Set(recettes.map((r) => r.factory))].sort((a, b) => a.localeCompare(b));
  const posees = new Set(data.stations.flatMap((s) => s.modules));
  const familles = ['ship', 'gun', 'equipment', 'commodity'].filter((f) => recettes.some((r) => famille(r.category) === f));

  const liste = h('div');

  const peindre = () => {
    const mots = aPlat(st.search).split(/\s+/).filter(Boolean);
    const vues = recettes.filter((r) => {
      if (st.family && famille(r.category) !== st.family) return false;
      if (st.factory !== '' && st.factory !== r.factory) return false;
      if (st.ours && !posees.has(r.factory)) return false;
      if (!mots.length) return true;
      const foin = aPlat([r.name, r.infotext, r.factory, r.command,
        ...r.consumed.map((c) => o.nom(c.nick)),
        ...r.choices.flatMap((c) => c.options.map((x) => o.nom(x.nick)))].join(' '));
      return mots.every((w) => foin.includes(w));
    });

    clear(liste);
    if (!vues.length) { liste.appendChild(empty(t('prod.noMatch'), t('prod.noMatchHint'))); return; }

    const parUsine = new Map();
    for (const r of vues) {
      if (!parUsine.has(r.factory)) parUsine.set(r.factory, []);
      parUsine.get(r.factory).push(r);
    }
    // Les recettes dont darkstat ne nomme pas l'usine ferment la marche.
    const ordre = (a, b) => Number(!a[0]) - Number(!b[0]) || a[0].localeCompare(b[0]);
    for (const [usine, groupe] of [...parUsine.entries()].sort(ordre)) {
      const hotes = data.stations.filter((s) => s.modules.includes(usine));
      liste.appendChild(panel(usine || t('prod.noFactory'), {
        count: groupe.length, flush: true,
        tools: hotes.length
          ? h('span.crew', hotes.map((s) => h('span.chip.is-me', { title: s.name }, s.code)))
          : (usine ? h('span.hint', t('prod.moduleNowhere')) : null),
      }, h('div.rcps', groupe.map((r) => ligneRecette(r, data, pool, o, st)))));
    }
  };

  const recherche = input({
    type: 'search', placeholder: t('prod.search'), 'aria-label': t('prod.search'), value: st.search,
    onInput: (e) => { st.search = e.target.value; peindre(); },
  });

  const barre = h('div.toolbar',
    recherche,
    h('div.tabs', [['', t('prod.famAll')], ...familles.map((f) => [f, t(`prod.fam.${f}`)])].map(([v, label]) =>
      h('button.chip', { type: 'button', class: st.family === v ? 'is-on' : null,
        onClick: (e) => {
          st.family = v;
          for (const c of e.currentTarget.parentElement.children) c.classList.remove('is-on');
          e.currentTarget.classList.add('is-on');
          peindre();
        } }, label))),
    select([{ value: '', label: t('prod.allFactories') },
      ...usines.filter(Boolean).map((u) => ({ value: u, label: u }))],
    { value: st.factory, 'aria-label': t('prod.factory'),
      onChange: (e) => { st.factory = e.target.value; peindre(); } }),
    h('label.check',
      h('input', { type: 'checkbox', checked: st.ours,
        onChange: (e) => { st.ours = e.target.checked; peindre(); } }),
      t('prod.oursOnly')),
  );

  peindre();
  return h('div', barre, liste);
}

/** Ce que nos stations peuvent lancer tout de suite de cette recette. */
function disponibilite(r, data, pool) {
  const hotes = stationsFor(r, data.stations).filter((s) => !r.factory || s.modules.includes(r.factory));
  if (!hotes.length) return { ton: 'off', texte: t('prod.availNoModule') };
  let meilleur = null;
  for (const s of hotes) {
    const lots = capacity(r, s, pool);
    if (!meilleur || lots > meilleur.lots) meilleur = { lots, station: s };
  }
  return meilleur.lots > 0
    ? { ton: 'ok', texte: t('prod.availLots', { n: num(meilleur.lots), v: meilleur.station.code }) }
    : { ton: 'bad', texte: t('prod.availShort', { v: hotes.map((s) => s.code).join(', ') }) };
}

function ligneRecette(r, data, pool, o, st) {
  const dispo = disponibilite(r, data, pool);
  const produit = r.produced[0];
  const corps = h('div.rcp__body');

  // Le détail n'est bâti qu'à l'ouverture : 263 tableaux d'un coup
  // alourdiraient un écran dont on n'ouvre que deux ou trois lignes.
  const batir = () => { if (!corps.firstChild) corps.appendChild(detailRecette(r, data, pool, o)); };

  const el = h('details.rcp', {
    open: st.openRecipes.has(r.nick),
    onToggle: (e) => {
      if (e.target.open) { st.openRecipes.add(r.nick); batir(); } else st.openRecipes.delete(r.nick);
    },
  },
  h('summary.rcp__row',
    h('span.rcp__name', h('strong', r.name),
      r.infotext && aPlat(r.infotext) !== aPlat(r.name) ? h('em.hint', r.infotext) : null),
    h('span.rcp__yield', produit && produit.qty > 1 ? `× ${num(produit.qty)}` : ''),
    h('span.rcp__time', duree(r.minutes)),
    h('span.rcp__tags',
      r.level > 0 ? h('span.tag', { title: t('prod.levelHint') }, t('prod.level', { v: r.level })) : null,
      r.restricted ? h('span.tag.is-low', { title: t('prod.restrictedHint') }, t('prod.restricted')) : null,
      r.loops ? h('span.tag.tag--auto', { title: t('prod.loopHint') }, t('prod.loop')) : null),
    h('span.avail', { class: `is-${dispo.ton}` }, dispo.texte),
    h('button.btn.btn--steel.btn--sm', {
      type: 'button',
      onClick: (e) => { e.preventDefault(); o.commander({ recipe: r.nick }); },
    }, t('prod.order')),
  ),
  corps,
  );
  if (el.open) batir();
  return el;
}

function detailRecette(r, data, pool, o) {
  const stations = data.stations;
  const ton = (qte, besoin) => (qte >= besoin ? 'ok' : qte > 0 ? 'low' : 'empty');
  const rang = (nick, qte, extra = {}) => h('tr', { class: extra.alt ? 'is-alt' : null },
    h('td', extra.alt ? h('span.hint', `${t('prod.or')} `) : null, marchandise(o, nick, { catalyst: extra.catalyst })),
    h('td', { class: 'num' }, num(qte)),
    ...stations.map((s) => {
      const q = pool[nick]?.[s.id] || 0;
      return h('td', { class: `num is-${ton(q, qte)}` }, num(q));
    }),
  );

  const rangs = [
    ...r.consumed.map((c) => rang(c.nick, c.qty)),
    ...r.choices.flatMap((choix) => choix.options.map((x, i) => rang(x.nick, x.qty, { alt: i > 0 }))),
    ...r.catalysts.map((c) => rang(c.nick, c.qty, { catalyst: true })),
  ];

  const nous = new Set(stations.map((s) => s.factionNick).filter(Boolean));
  const sorties = r.produced.map((p) => `${num(p.qty)} × ${o.nom(p.nick)}` +
    ((p.byFaction || []).length
      ? ` (${p.byFaction.map((f) => `${o.nom(f.faction)} : ${o.nom(f.nick)}`).join(', ')})` : ''));

  return h('div',
    h('table.table.table--mats',
      h('thead', h('tr',
        h('th', t('prod.colGoods')), h('th', { class: 'num' }, t('prod.colPerRun')),
        ...stations.map((s) => h('th', { class: 'num', title: s.name }, s.code)))),
      h('tbody', rangs)),
    h('dl.rcp__facts',
      h('dt', t('prod.produces')), h('dd', sorties.join(' · ')),
      r.command ? [h('dt', t('prod.command')), h('dd', h('code', r.command))] : null,
      r.bonuses.length ? [h('dt', r.restricted ? t('prod.reservedTo') : t('prod.bonuses')),
        h('dd.crew', r.bonuses.map((b) => h('span.chip', { class: nous.has(b.faction) ? 'is-me' : null },
          o.nom(b.faction), b.mult !== 1 ? h('b', ` ×${dec(b.mult)}`) : null)))] : null,
    ),
  );
}

/* ===================================================== volet stations */

function voletStations(data, o, ctx) {
  const recettes = data.recipes.filter((r) => !r.retired);
  const usines = [...new Set(recettes.map((r) => r.factory).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const parUsine = (u) => recettes.filter((r) => r.factory === u).length;

  const regler = async (s) => {
    const cases = usines.map((u) => h('label.check.check--row',
      h('input', { type: 'checkbox', value: u, checked: s.modules.includes(u) }),
      h('span', u), h('em.hint', t2('prod.recipesCount', parUsine(u)))));
    const v = await modal({
      title: t('prod.modulesOf', { v: s.name }), width: '560px',
      build: () => h('div', h('p.hint', { style: 'margin-top:0' }, t('prod.modulesHint')), h('div.checks', cases)),
      actions: [{ label: t('common.cancel'), value: null },
        { label: t('common.save'), variant: 'primary',
          onClick: (c) => c(cases.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value)) }],
    });
    if (v) o.agir(() => put(`/admin/stations/${s.id}/modules`, { modules: v }), t('prod.saved'));
  };

  const cartes = data.stations.map((s) => {
    const possibles = recettes.filter((r) => r.factory && s.modules.includes(r.factory) && !obstacles(r, s).length).length;
    return h('article.station.station--static',
      h('div.station__top',
        h('span.station__code', s.code), h('h3.station__name', s.name),
        s.level != null ? h('span.tag', t('prod.core', { v: s.level })) : null),
      h('div.station__vitals',
        h('div.vital', h('span', t('prod.affiliation')), h('b', s.factionName || '—')),
        h('div.vital', h('span', t('prod.buildable')), h('b', num(possibles)))),
      s.modules.length
        ? h('div.crew.modules', s.modules.map((m) => h('span.chip', m)))
        : h('p.hint', { style: 'margin:.9rem 0 0' }, t('prod.noModules')),
      data.me.officer ? h('button.btn.btn--steel.btn--sm', { type: 'button', style: 'margin-top:.9rem',
        onClick: () => regler(s) }, t('prod.setModules')) : null,
    );
  });

  return h('div',
    h('p.hint', { style: 'margin:0 0 1rem;max-width:72ch' }, t('prod.stationsHint')),
    data.stations.length ? h('div.grid.grid--stations', cartes) : empty(t('stations.empty'), t('stations.emptyHint')),
    h('div.toolbar', { style: 'margin-top:1.2rem' },
      h('span.hint', t('prod.catalogRead', { n: num(recettes.length), v: ago(data.syncedAt) })),
      data.me.officer ? boutonReleve(ctx) : null),
  );
}

function boutonReleve(ctx) {
  return h('button.btn.btn--ghost.btn--sm', {
    type: 'button',
    onClick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = t('prod.syncing');
      try {
        // Deux mégaoctets d'infocards : le délai ordinaire n'y suffit pas.
        const r = await api('/admin/production/sync', { method: 'POST', timeoutMs: 90_000 });
        toast(t('prod.synced', { n: num(r.recipes) }));
        ctx.reload();
      } catch (err) { notifyError(err); b.disabled = false; b.textContent = t('prod.sync'); }
    },
  }, t('prod.sync'));
}

/* ================================================ saisie d'une commande */

/**
 * Brouillon de commande.
 *
 * On y empile des fabrications ; le tableau du bas dit, à chaque ajout, ce
 * que le lot réclame en plus de la file déjà saisie — c'est la réponse à
 * « est-ce qu'on a de quoi ? » avant même d'enregistrer.
 *
 * @param opts.orderId  ajoute à une commande existante au lieu d'en créer une
 * @param opts.recipe   recette posée d'emblée dans le brouillon
 */
async function dialogueCommande(o, { orderId = null, recipe = null } = {}) {
  const { data } = o;
  const recettes = data.recipes.filter((r) => !r.retired);

  // Libellé unique par recette : deux variantes d'une même pièce ne se
  // distinguent que par leur usine ou leur commande.
  const compte = new Map();
  for (const r of recettes) compte.set(r.name, (compte.get(r.name) || 0) + 1);
  const libelle = (r) => (compte.get(r.name) > 1
    ? `${r.name} — ${r.factory || t('prod.noFactory')}${r.command ? ` (${r.command.replace('/craft ', '')})` : ''}`
    : r.name);
  const parLibelle = new Map(recettes.map((r) => [aPlat(libelle(r)), r]));

  const miennes = data.orders.filter((x) => x.status === 'open' && o.peut(x));
  let cible = orderId ?? '';
  const brouillon = [];
  let cle = 0;

  const client = input({ name: 'client', maxlength: '80', placeholder: t('prod.clientHint') });
  const note = input({ name: 'note', maxlength: '400', placeholder: t('common.optional') });
  const identite = h('div.draft__who', field(t('prod.client'), client), field(t('common.note'), note));

  const choixCible = miennes.length ? select(
    [{ value: '', label: t('prod.targetNew') },
      ...miennes.map((x) => ({ value: x.id, label: t('prod.targetExisting', { v: x.client }) }))],
    { value: cible, onChange: (e) => { cible = e.target.value; identite.hidden = !!cible; } }) : null;
  identite.hidden = !!cible;

  const idListe = 'prod-recipes';
  const choixRecette = input({ list: idListe, placeholder: t('prod.pickRecipe'), autocomplete: 'off' });
  const quantite = input({ type: 'number', min: '1', step: '1', value: 1, class: 'input--num' });
  const choixStation = select([{ value: '', label: t('prod.autoStationAny') },
    ...data.stations.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))]);

  const lignes = h('div.draft__lines');
  const recap = h('div.draft__recap');

  const peindre = () => {
    clear(lignes);
    if (!brouillon.length) lignes.appendChild(h('p.hint', { style: 'margin:0' }, t('prod.draftEmpty')));
    const simule = plan(data, brouillon.map((b) => ({ id: b.cle, recipe: b.recipe.nick, name: b.recipe.name,
      quantity: b.quantity, stationId: b.stationId }))).draft;

    simule.forEach((l, i) => {
      const b = brouillon[i];
      lignes.appendChild(h('div.draft__line',
        h('strong', `${num(b.quantity)} × ${b.recipe.name}`),
        h('em.hint', [b.recipe.factory || t('prod.noFactory'), l.station ? l.station.code : t('prod.noStation'),
          t2('prod.runs', l.runs), duree(l.minutes)].join(' · ')),
        etiquette(l.state),
        h('button.btn.btn--ghost.btn--sm', { type: 'button', 'aria-label': t('prod.removeLine'),
          onClick: () => { brouillon.splice(i, 1); peindre(); } }, '×'),
      ));
      for (const issue of l.issues) {
        lignes.appendChild(h('p.oline__issue', t(`prod.issue.${issue}`, {
          station: l.station?.name || '', factory: b.recipe.factory, level: b.recipe.level })));
      }
    });

    clear(recap);
    if (!simule.length) return;
    const courses = shopping(simule).sort((a, b) => b.missing - a.missing || b.elsewhere - a.elsewhere);
    const manquants = courses.filter((e) => e.missing > 0).length;
    recap.append(
      h('div.draft__verdict',
        h('span', t('prod.draftNeeds')),
        manquants ? h('span.tag.is-low', t2('prod.matMissing', manquants)) : h('span.tag.is-ok', t('prod.matReady')),
        h('span.spacer'),
        h('span.hint', t('prod.draftTime', { v: duree(simule.reduce((a, l) => a + l.minutes, 0)) }))),
      h('table.table.table--mats',
        h('thead', h('tr', h('th', t('prod.colGoods')), h('th', t('prod.station')),
          h('th', { class: 'num' }, t('prod.colNeed')), h('th', { class: 'num' }, t('prod.colOnSiteShort')),
          h('th', { class: 'num' }, t('prod.colElsewhere')), h('th', { class: 'num' }, t('prod.colImport')))),
        h('tbody', courses.map((e) => h('tr',
          h('td', h('strong', o.nom(e.nick)), e.catalyst ? h('span.tag.tag--auto', t('prod.catalyst')) : null),
          h('td', o.code(e.stationId)),
          h('td', { class: 'num' }, num(e.need)),
          h('td', { class: `num ${e.onSite >= e.need ? 'is-ok' : ''}` }, num(e.onSite)),
          h('td', { class: `num ${e.elsewhere ? 'is-move' : ''}` }, e.elsewhere ? num(e.elsewhere) : '—'),
          h('td', { class: `num ${e.missing ? 'is-empty' : 'is-ok'}` }, e.missing ? num(e.missing) : '✓'),
        )))),
    );
  };

  const ajouter = (r = null) => {
    const trouvee = r || parLibelle.get(aPlat(choixRecette.value.trim()));
    if (!trouvee) { toast(t('prod.pickRecipeFirst'), 'err'); choixRecette.focus(); return; }
    const q = Math.round(Number(quantite.value) || 0);
    if (!(q >= 1)) { toast(t('prod.qtyRequired'), 'err'); quantite.focus(); return; }
    brouillon.push({ cle: `d${cle++}`, recipe: trouvee, quantity: q,
      stationId: choixStation.value ? Number(choixStation.value) : null });
    choixRecette.value = ''; quantite.value = 1;
    peindre();
    choixRecette.focus();
  };

  if (recipe && o.recettes.get(recipe)) {
    brouillon.push({ cle: `d${cle++}`, recipe: o.recettes.get(recipe), quantity: 1, stationId: null });
  }
  // Entrée dans le champ de recette ou de quantité ajoute la ligne.
  for (const champ of [choixRecette, quantite]) {
    champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ajouter(); } });
  }

  const envoyer = async (fermer) => {
    if (!brouillon.length) { toast(t('prod.draftEmpty'), 'err'); return; }
    const corps = brouillon.map((b) => ({ recipe: b.recipe.nick, quantity: b.quantity, stationId: b.stationId }));
    try {
      if (cible) {
        for (const l of corps) await post(`/production/orders/${cible}/lines`, l);
      } else {
        if (!client.value.trim()) { toast(t('prod.clientRequired'), 'err'); client.focus(); return; }
        await post('/production/orders', { client: client.value, note: note.value, lines: corps });
      }
      fermer(true);
      toast(t('prod.orderSaved'));
      o.ctx.prod.tab = 'orders';
      o.ctx.reload();
    } catch (e) { notifyError(e); }
  };

  peindre();
  await modal({
    title: orderId ? t('prod.addLineTitle', { v: o.data.orders.find((x) => x.id === orderId)?.client || '' }) : t('prod.newOrder'),
    width: '860px',
    build: () => h('div.draft',
      !orderId && choixCible ? field(t('prod.target'), choixCible) : null,
      identite,
      h('div.draft__add',
        h('label.field', h('span', t('prod.recipe')), choixRecette,
          h('datalist', { id: idListe }, recettes.map((r) => h('option', { value: libelle(r) })))),
        h('label.field', h('span', t('prod.qty')), quantite),
        h('label.field', h('span', t('prod.station')), choixStation),
        h('button.btn.btn--steel', { type: 'button', onClick: () => ajouter() }, t('prod.add')),
      ),
      lignes,
      recap,
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('prod.saveOrder'), variant: 'primary', onClick: envoyer },
    ],
  });
}
