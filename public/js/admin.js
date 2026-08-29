/* =====================================================================
   Console de gestion.
   Tout ce qui se paramètre se paramètre ici : plus aucun aller-retour
   vers un tableur ou un dépôt de code pour ajouter une station.
   ===================================================================== */

import {
  h, get, post, put, del, num, ago, dateShort, toast, notifyError, modal,
  confirmDialog, field, input, select, loading, empty, panel, clear, readForm,
} from './ui.js';

const TABS = [
  { key: 'stations', label: 'Stations', role: 'officer' },
  { key: 'thresholds', label: 'Seuils', role: 'officer' },
  { key: 'missions', label: 'Missions', role: 'officer' },
  { key: 'items', label: 'Marchandises', role: 'officer' },
  { key: 'routes', label: 'Routes', role: 'officer' },
  { key: 'recipes', label: 'Recettes', role: 'officer' },
  { key: 'users', label: 'Pilotes', role: 'admin' },
  { key: 'sync', label: 'Synchronisation', role: 'officer' },
];

const RANK = { member: 0, officer: 1, admin: 2 };

export async function adminView(ctx) {
  const allowed = TABS.filter((t) => RANK[ctx.user.role] >= RANK[t.role]);
  const state = ctx.adminTab && allowed.some((t) => t.key === ctx.adminTab)
    ? ctx.adminTab : allowed[0].key;

  const stage = h('div', loading());

  const open = async (key) => {
    ctx.adminTab = key;
    for (const btn of tabs.children) btn.classList.toggle('is-on', btn.dataset.key === key);
    stage.replaceChildren(loading());
    try {
      stage.replaceChildren(await PANES[key](ctx));
    } catch (e) {
      stage.replaceChildren(empty('Chargement impossible', e.message));
    }
  };

  const tabs = h('div.tabs', allowed.map((t) =>
    h('button.chip', {
      type: 'button', dataset: { key: t.key },
      class: t.key === state ? 'is-on' : null,
      onClick: () => open(t.key),
    }, t.label)));

  open(state);

  return h('div',
    h('div.head', h('span.eyebrow', 'Administration'), h('h1', 'Gestion de la console')),
    h('div.toolbar', tabs),
    stage,
  );
}

/* ======================================================== utilitaires */

/** Tableau générique : colonnes déclaratives, actions par ligne. */
function table(columns, rows, renderRow) {
  return h('table.table',
    h('thead', h('tr', columns.map((c) =>
      h('th', { class: c.num ? 'num' : null }, c.label)))),
    h('tbody', rows.map(renderRow)),
  );
}

const addButton = (label, onClick) =>
  h('button.btn.btn--primary.btn--sm', { type: 'button', onClick }, label);

const rowActions = (...buttons) => h('td', { class: 'row-actions' }, buttons);

const editBtn = (onClick) =>
  h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick }, 'Modifier');

const deleteBtn = (onClick) =>
  h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick }, 'Supprimer');

/** Ouvre un formulaire modal et renvoie les valeurs, ou null si annulé. */
function formModal(title, buildFields, { submitLabel = 'Enregistrer', width = null } = {}) {
  let form;
  return modal({
    title, width,
    build: () => (form = h('div.form', buildFields())),
    actions: [
      { label: 'Annuler', value: null },
      { label: submitLabel, variant: 'primary', onClick: (close) => close(readForm(form)) },
    ],
  });
}

/* ============================================================ stations */

async function stationsPane(ctx) {
  const stations = await get('/admin/stations');

  const edit = async (station = null) => {
    const values = await formModal(station ? 'Modifier la station' : 'Déclarer une station', () => [
      field('Nom affiché', input({ name: 'name', value: station?.name || '', required: true })),
      field('Nom exact dans l\'API', input({ name: 'api_name', value: station?.api_name || '' }),
        'Doit correspondre au caractère près au champ « name » renvoyé par darkstat, sans quoi la soute restera vide.'),
      field('Code court', input({ name: 'code', value: station?.code || '', maxlength: '5', placeholder: 'KOC' })),
      field('Système', input({ name: 'system', value: station?.system || '' })),
      field('Ordre d\'affichage', input({ type: 'number', name: 'sort_order', value: station?.sort_order ?? 0, class: 'input--num' })),
      field('Station active', h('input', { type: 'checkbox', name: 'active', checked: station ? !!station.active : true })),
    ]);
    if (!values) return;
    try {
      if (station) await put(`/admin/stations/${station.id}`, values);
      else await post('/admin/stations', values);
      toast(station ? 'Station mise à jour.' : 'Station déclarée. Elle se remplira au prochain relevé.');
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const remove = async (station) => {
    if (!await confirmDialog('Supprimer la station',
      `${station.name}, son inventaire et ses missions seront effacés. Cette action est définitive.`,
      'Supprimer')) return;
    try {
      await del(`/admin/stations/${station.id}`);
      toast('Station supprimée.');
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  return panel('Stations', {
    count: stations.length, flush: true,
    tools: addButton('Déclarer une station', () => edit()),
  },
  stations.length
    ? table(
      [{ label: 'Code' }, { label: 'Nom' }, { label: 'Nom API' }, { label: 'Système' },
        { label: 'Relevé' }, { label: 'État' }, { label: '' }],
      stations,
      (s) => h('tr', { class: s.active ? null : 'is-off' },
        h('td', h('span.station__code', s.code)),
        h('td', h('strong', s.name)),
        h('td', h('code', s.api_name)),
        h('td', s.system || '—'),
        h('td', s.synced_at ? ago(s.synced_at) : h('em.hint', 'jamais')),
        h('td', s.active ? 'Active' : h('em.hint', 'Désactivée')),
        rowActions(editBtn(() => edit(s)), ctx.user.role === 'admin' ? deleteBtn(() => remove(s)) : null),
      ))
    : empty('Aucune station',
      'Déclarez vos bases pour que la synchronisation commence à relever leurs soutes.',
      addButton('Déclarer une station', () => edit())),
  );
}

/* ============================================================== seuils */

/**
 * Les seuils de l'API décrivent la configuration en jeu. Un plafond à
 * 999 999 999 sert à laisser n'importe quel joueur vendre sans butoir, pas
 * à exprimer notre besoin. On règle donc ici les valeurs qui pilotent
 * réellement l'ouverture des missions, sans toucher à la station en jeu.
 */
async function thresholdsPane(ctx) {
  const stations = await get('/stations');
  if (!stations.length) {
    return panel('Seuils', {}, empty('Aucune station',
      'Déclarez d\'abord vos stations, puis lancez un relevé.'));
  }

  const state = ctx.seuilStation ||= String(stations[0].id);
  const filtre = input({ type: 'search', placeholder: 'Filtrer une marchandise…' });
  const host = h('div', loading());

  const choix = select(stations.map((s) => ({ value: s.id, label: s.name })), {
    value: state,
    onChange: (e) => { ctx.seuilStation = e.target.value; charger(); },
  });

  let inventaire = [];

  const charger = async () => {
    host.replaceChildren(loading());
    try {
      const { inventory } = await get(`/admin/stations/${ctx.seuilStation}/thresholds`);
      inventaire = inventory;
      rendre();
    } catch (e) { host.replaceChildren(empty('Lecture impossible', e.message)); }
  };

  const rendre = () => {
    const q = filtre.value.trim().toLowerCase();
    const lignes = inventaire.filter((r) => !q || r.name.toLowerCase().includes(q));
    // Les marchandises réglées remontent : ce sont celles qu'on revient voir.
    lignes.sort((a, b) => (b.has_custom | 0) - (a.has_custom | 0) || a.name.localeCompare(b.name));

    if (!lignes.length) {
      host.replaceChildren(empty(
        inventaire.length ? 'Aucun résultat' : 'Soute vide',
        inventaire.length ? 'Essayez un autre terme.'
          : 'Lancez un relevé pour que les marchandises apparaissent.'));
      return;
    }

    host.replaceChildren(table(
      [{ label: 'Marchandise' }, { label: 'Sens' }, { label: 'En soute', num: true },
        { label: 'Seuil bas', num: true }, { label: 'Plafond', num: true },
        { label: 'Prime', num: true }, { label: 'API' }, { label: '' }],
      lignes,
      (r) => h('tr', { class: [r.has_custom ? 'is-custom' : '', r.is_hidden ? 'is-off' : ''].filter(Boolean).join(' ') || null },
        h('td', h('strong', r.name),
          r.threshold_note ? h('em.hint', r.threshold_note) : null),
        h('td',
          r.is_hidden
            ? h('span.way', { title: 'Retirée du tableau des missions' }, 'Masquée')
            : h(`span.way.way--${r.is_export ? 'export' : 'import'}`,
              r.is_export ? 'À enlever' : 'À livrer')),
        h('td', { class: 'num' }, num(r.effective_qty)),
        h('td', { class: `num ${r.custom_min_stock != null ? 'is-ok' : ''}` }, num(r.min_stock)),
        h('td', { class: `num ${r.custom_max_stock != null ? 'is-ok' : ''}` }, num(r.max_stock)),
        h('td', { class: `num ${r.risk_bonus > 1 ? 'is-ok' : ''}` },
          r.risk_bonus > 1 ? `×${r.risk_bonus}` : '—'),
        h('td', h('em.hint', `${num(r.api_min_stock)} → ${num(r.api_max_stock)}`)),
        rowActions(
          editBtn(() => regler(r)),
          r.has_custom ? deleteBtn(() => lever(r)) : null,
        ),
      ),
    ));
  };

  const regler = async (r) => {
    const min = input({ type: 'number', name: 'min_stock', min: '0', step: '1',
      class: 'input--num', value: r.custom_min_stock ?? '' });
    const max = input({ type: 'number', name: 'max_stock', min: '0', step: '1',
      class: 'input--num', value: r.custom_max_stock ?? '' });
    const note = input({ name: 'note', value: r.threshold_note || '',
      placeholder: 'Pourquoi cette valeur ? (facultatif)' });
    const exporter = h('input', { type: 'checkbox', name: 'is_export', checked: !!r.is_export });
    const masquer = h('input', { type: 'checkbox', name: 'is_hidden', checked: !!r.is_hidden });
    const prime = input({ type: 'number', name: 'risk_bonus', min: '0.1', max: '10', step: '0.1',
      class: 'input--num', value: r.risk_bonus ?? 1 });

    const valeurs = await modal({
      title: r.name,
      build: () => h('div.form',
        h('p', { style: 'margin-top:0' },
          'Valeurs de l\'API : seuil bas ', h('strong', num(r.api_min_stock)),
          ', plafond ', h('strong', num(r.api_max_stock)), '.'),
        field('Seuil bas', min,
          'En dessous, une mission d\'approvisionnement s\'ouvre automatiquement. ' +
          'Laisser vide pour garder la valeur de l\'API.'),
        field('Plafond', max,
          'Sert de repère haut sur la jauge. Laisser vide pour garder la valeur de l\'API.'),
        field('Marchandise produite, à enlever', exporter,
          'Cochez pour une marchandise que la station produit : la mission s\'ouvrira ' +
          'quand le stock DÉPASSE le plafond, pour venir chercher le surplus. ' +
          'Décochée, la mission s\'ouvre quand le stock passe SOUS le seuil bas.'),
        field('Prime de risque permanente', prime,
          'Multiplie les points de toute livraison de cette marchandise ici. ' +
          '1 = trajet ordinaire. Utilisez-la pour ce qui traverse un territoire ' +
          'pirate ou s\'obtient au combat. Se cumule avec la prime ponctuelle ' +
          'd\'une mission créée à la main.'),
        field('Masquer cette marchandise', masquer,
          'Aucune mission ne sera ouverte, et celles en cours seront closes. ' +
          'Pour ce qui ne se produit que sur commande.'),
        field('Note', note),
      ),
      actions: [
        { label: 'Annuler', value: null },
        { label: 'Enregistrer', variant: 'primary', onClick: (close) => close({
          min_stock: min.value === '' ? null : Number(min.value),
          max_stock: max.value === '' ? null : Number(max.value),
          is_export: exporter.checked ? 1 : 0,
          is_hidden: masquer.checked ? 1 : 0,
          risk_bonus: Number(prime.value) || 1,
          note: note.value.trim() || null,
        }) },
      ],
    });

    if (!valeurs) return;
    try {
      await put(`/admin/stations/${ctx.seuilStation}/thresholds/${r.item_id}`, valeurs);
      toast('Seuils enregistrés.');
      charger();
    } catch (e) { notifyError(e); }
  };

  const lever = async (r) => {
    if (!await confirmDialog('Revenir aux valeurs de l\'API',
      `${r.name} reprendra le seuil bas ${num(r.api_min_stock)} et le plafond ${num(r.api_max_stock)}.`,
      'Rétablir')) return;
    try {
      await put(`/admin/stations/${ctx.seuilStation}/thresholds/${r.item_id}`,
        { min_stock: null, max_stock: null, is_export: 0, is_hidden: 0,
          risk_bonus: 1, note: null });
      toast('Valeurs de l\'API rétablies.');
      charger();
    } catch (e) { notifyError(e); }
  };

  let minuteur;
  filtre.addEventListener('input', () => { clearTimeout(minuteur); minuteur = setTimeout(rendre, 200); });
  charger();

  return panel('Seuils par station', { flush: true, tools: choix },
    h('div', { style: 'padding:.75rem 1rem 0' }, filtre),
    host,
  );
}

/* ============================================================ missions */

async function missionsPane(ctx) {
  const [stations, missions] = await Promise.all([get('/stations'), get('/missions')]);
  const manual = missions.filter((m) => !m.auto);
  const auto = missions.filter((m) => m.auto);

  const create = async () => {
    const values = await formModal('Ouvrir une mission', () => [
      field('Station', select(stations.map((s) => ({ value: s.id, label: s.name })), { name: 'station_id' })),
      field('Marchandise', input({ name: 'item_name', placeholder: 'Nom exact de la marchandise' }),
        'Si elle n\'existe pas encore, elle sera créée automatiquement.'),
      field('Sens', select([
        { value: 'import', label: 'Approvisionnement — livrer à la station' },
        { value: 'export', label: 'Enlèvement — retirer de la station' },
      ], { name: 'direction' })),
      field('Tonnage demandé', input({ type: 'number', name: 'target_qty', value: 0, class: 'input--num' })),
      field('Où charger', input({ name: 'origin', placeholder: 'Base PNJ, système, autre station…' })),
      field('Priorité', select([
        { value: 'normal', label: 'Normale' }, { value: 'high', label: 'Haute' },
        { value: 'critical', label: 'Critique' }, { value: 'low', label: 'Basse' },
      ], { name: 'priority' })),
      field('Prime de risque', input({ type: 'number', name: 'reward_multiplier',
        min: '0.1', max: '10', step: '0.1', value: '1', class: 'input--num' }),
      'Multiplie les points gagnés. 1 = trajet ordinaire, 1.5 = passage exposé, ' +
      '2 = franchement dangereux. Figée à la livraison.'),
    ], { submitLabel: 'Ouvrir la mission' });
    if (!values) return;
    try {
      await post('/admin/missions', values);
      toast('Mission ouverte.');
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const archive = async (m) => {
    if (!await confirmDialog('Archiver la mission',
      `${m.item_name} · ${m.station_name}. Les engagements en cours seront clos.`, 'Archiver')) return;
    try {
      await del(`/admin/missions/${m.id}`);
      toast('Mission archivée.');
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const row = (m) => h('tr',
    h('td', h('strong', m.item_name)),
    h('td', m.station_name),
    h('td', m.direction === 'import' ? 'Approvisionnement' : 'Enlèvement'),
    h('td', { class: 'num' }, num(m.target_qty)),
    h('td', { class: 'num' }, num(m.pledged_qty)),
    h('td', `${m.claim_count} pilote${m.claim_count > 1 ? 's' : ''}`),
    rowActions(deleteBtn(() => archive(m))),
  );

  const cols = [{ label: 'Marchandise' }, { label: 'Station' }, { label: 'Sens' },
    { label: 'Demandé', num: true }, { label: 'Engagé', num: true }, { label: 'Équipage' }, { label: '' }];

  return h('div',
    panel('Missions déclarées à la main', {
      count: manual.length, flush: true, tools: addButton('Ouvrir une mission', create),
    },
    manual.length ? table(cols, manual, row)
      : empty('Aucune mission manuelle',
        'Les besoins sous seuil s\'ouvrent tout seuls. Ouvrez une mission ici pour un besoin ponctuel.',
        addButton('Ouvrir une mission', create))),

    panel('Missions ouvertes automatiquement', { count: auto.length, flush: true },
      auto.length
        ? table(cols, auto, row)
        : empty('Aucun seuil franchi', 'Toutes les soutes suivies sont au-dessus de leur seuil bas.')),
  );
}

/* ======================================================= marchandises */

async function itemsPane(ctx) {
  const search = input({ type: 'search', placeholder: 'Filtrer les marchandises…' });
  const host = h('div', loading());

  const load = async () => {
    host.replaceChildren(loading());
    try {
      const items = await get(`/admin/items?q=${encodeURIComponent(search.value.trim())}`);
      host.replaceChildren(items.length
        ? table(
          [{ label: 'Nom' }, { label: 'Identifiant interne' }, { label: 'Catégorie' },
            { label: 'Où en trouver' }, { label: '' }],
          items,
          (it) => h('tr',
            h('td', h('strong', it.name)),
            h('td', it.commodity_id ? h('code', it.commodity_id) : h('em.hint', '—')),
            h('td', it.category),
            h('td', it.vendor_hint || h('em.hint', 'non renseigné')),
            rowActions(editBtn(() => edit(it)),
              ctx.user.role === 'admin' ? deleteBtn(() => remove(it)) : null),
          ))
        : empty('Aucune marchandise', 'Elles apparaissent toutes seules au premier relevé de l\'API.'));
    } catch (e) { host.replaceChildren(empty('Lecture impossible', e.message)); }
  };

  const edit = async (item = null) => {
    const values = await formModal(item ? 'Modifier la marchandise' : 'Ajouter une marchandise', () => [
      field('Nom', input({ name: 'name', value: item?.name || '' }),
        'Doit correspondre au nom renvoyé par l\'API pour que les stocks se rattachent.'),
      field('Identifiant interne', input({ name: 'commodity_id', value: item?.commodity_id || '' }),
        'Nickname du fichier de recettes Discovery. Sert à relier recettes et stocks.'),
      field('Catégorie', input({ name: 'category', value: item?.category || 'commodity' })),
      field('Où en trouver', input({ name: 'vendor_hint', value: item?.vendor_hint || '' }),
        'Affiché aux pilotes sur la mission.'),
    ]);
    if (!values) return;
    try {
      if (item) await put(`/admin/items/${item.id}`, values);
      else await post('/admin/items', values);
      toast('Marchandise enregistrée.');
      load();
    } catch (e) { notifyError(e); }
  };

  const remove = async (item) => {
    if (!await confirmDialog('Supprimer la marchandise',
      `${item.name} disparaîtra des stocks, recettes et routes.`, 'Supprimer')) return;
    try { await del(`/admin/items/${item.id}`); toast('Marchandise supprimée.'); load(); }
    catch (e) { notifyError(e); }
  };

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  load();

  return panel('Marchandises', { flush: true, tools: addButton('Ajouter', () => edit()) },
    h('div', { style: 'padding:.75rem 1rem 0' }, search), host);
}

/* ============================================================== routes */

async function routesPane(ctx) {
  const [routes, stations] = await Promise.all([get('/admin/routes'), get('/stations')]);

  const create = async () => {
    const values = await formModal('Déclarer une route', () => [
      field('Marchandise', input({ name: 'item_name' })),
      field('Station de destination',
        select(stations.map((s) => ({ value: s.id, label: s.name })), { name: 'dest_id' })),
      field('Station d\'origine',
        select([{ value: '', label: 'Hors faction — préciser ci-dessous' },
          ...stations.map((s) => ({ value: s.id, label: s.name }))], { name: 'source_id' })),
      field('Origine hors faction', input({ name: 'source_label', placeholder: 'Base PNJ, système…' })),
      field('Priorité', input({ type: 'number', name: 'priority', value: 0, class: 'input--num' })),
    ], { submitLabel: 'Déclarer' });
    if (!values) return;
    try { await post('/admin/routes', values); toast('Route déclarée.'); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  const remove = async (r) => {
    if (!await confirmDialog('Supprimer la route', `${r.item_name} vers ${r.dest_name}.`, 'Supprimer')) return;
    try { await del(`/admin/routes/${r.id}`); toast('Route supprimée.'); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  return panel('Routes commerciales', {
    count: routes.length, flush: true, tools: addButton('Déclarer une route', create),
  },
  routes.length
    ? table([{ label: 'Marchandise' }, { label: 'Origine' }, { label: 'Destination' },
      { label: 'Priorité', num: true }, { label: '' }],
    routes,
    (r) => h('tr',
      h('td', h('strong', r.item_name)),
      h('td', r.source_name || h('em.hint', r.source_label || 'non précisée')),
      h('td', r.dest_name),
      h('td', { class: 'num' }, num(r.priority)),
      rowActions(deleteBtn(() => remove(r))),
    ))
    : empty('Aucune route',
      'Une route dit d\'où vient une marchandise. Les pilotes la voient sur la mission.',
      addButton('Déclarer une route', create)),
  );
}

/* ============================================================ recettes */

async function recipesPane(ctx) {
  const [recipes, stations] = await Promise.all([get('/admin/recipes'), get('/stations')]);

  const edit = async (recipe = null) => {
    const rows = h('div.comp-rows');
    const addRow = (comp = null) => rows.appendChild(h('div.comp-row',
      input({ class: 'comp-name', placeholder: 'Composant', value: comp?.name || '' }),
      input({ type: 'number', class: 'input--num comp-qty', placeholder: 'Qté', min: '1', value: comp?.quantity || '' }),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: (e) => e.target.parentElement.remove() }, '×'),
    ));

    for (const c of recipe?.components || []) addRow(c);
    if (!recipe?.components?.length) addRow();

    let form;
    const values = await modal({
      title: recipe ? 'Modifier la recette' : 'Créer une recette',
      width: '640px',
      build: () => (form = h('div.form',
        field('Nom de l\'arme', input({ name: 'name', value: recipe?.name || '' })),
        field('Catégorie', input({ name: 'category', value: recipe?.category || 'weapon' })),
        field('Fabriquée à',
          select([{ value: '', label: 'Indifférent' },
            ...stations.map((s) => ({ value: s.id, label: s.name }))],
          { name: 'station_id', value: recipe?.station_id ?? '' })),
        field('Notes', input({ name: 'notes', value: recipe?.notes || '' })),
        h('div.field', h('span', 'Composants'), rows,
          h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => addRow() }, 'Ajouter un composant')),
      )),
      actions: [
        { label: 'Annuler', value: null },
        { label: 'Enregistrer', variant: 'primary', onClick: (close) => {
          const base = readForm(form);
          base.components = [...rows.querySelectorAll('.comp-row')].map((r) => ({
            name: r.querySelector('.comp-name').value.trim(),
            quantity: Number(r.querySelector('.comp-qty').value) || 0,
          })).filter((c) => c.name && c.quantity > 0);
          close(base);
        } },
      ],
    });

    if (!values) return;
    if (!values.name) return toast('La recette doit avoir un nom.', 'err');
    try {
      if (recipe) await put(`/admin/recipes/${recipe.id}`, values);
      else await post('/admin/recipes', values);
      toast('Recette enregistrée.');
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const remove = async (r) => {
    if (!await confirmDialog('Supprimer la recette', `${r.name} sera retirée de l'armurerie.`, 'Supprimer')) return;
    try { await del(`/admin/recipes/${r.id}`); toast('Recette supprimée.'); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  const runImport = async () => {
    const replace = await modal({
      title: 'Importer depuis Discovery',
      build: () => h('div',
        h('p', { style: 'margin-top:0' },
          'Le fichier public de recettes sera relu et les armes ajoutées à l\'armurerie.'),
        h('p.hint', { style: 'margin:0' },
          'Conserver l\'existant garde vos recettes saisies à la main et vos correspondances de noms. ' +
          'Tout remplacer les efface.'),
      ),
      actions: [
        { label: 'Annuler', value: null },
        { label: 'Conserver l\'existant', variant: 'primary', value: false },
        { label: 'Tout remplacer', variant: 'danger', value: true },
      ],
    });
    if (replace == null) return;
    toast('Import en cours…');
    try {
      const r = await post('/admin/recipes/import', { replace });
      toast(`${num(r.recipes ?? 0)} recettes importées.`);
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  return panel('Recettes', {
    count: recipes.length, flush: true,
    tools: h('span', { style: 'display:flex;gap:.5rem' },
      ctx.user.role === 'admin'
        ? h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: runImport }, 'Importer depuis Discovery')
        : null,
      addButton('Créer', () => edit())),
  },
  recipes.length
    ? table([{ label: 'Arme' }, { label: 'Catégorie' }, { label: 'Composants', num: true }, { label: '' }],
      recipes,
      (r) => h('tr',
        h('td', h('strong', r.name)),
        h('td', r.category),
        h('td', { class: 'num' }, num(r.components.length)),
        rowActions(editBtn(() => edit(r)), deleteBtn(() => remove(r))),
      ))
    : empty('Aucune recette',
      'Importez le fichier Discovery pour peupler l\'armurerie d\'un coup, ou saisissez une recette.',
      addButton('Créer une recette', () => edit())),
  );
}

/* ============================================================= pilotes */

async function usersPane(ctx) {
  const users = await get('/admin/users');

  const edit = async (user) => {
    const values = await formModal(user.display_name || user.username, () => [
      field('Indicatif en jeu', input({ name: 'callsign', value: user.callsign || '' }),
        'Nom affiché sur les missions et le classement.'),
      field('Rôle', select([
        { value: 'member', label: 'Pilote — prend et livre des missions' },
        { value: 'officer', label: 'Officier — gère stations, missions et recettes' },
        { value: 'admin', label: 'Administrateur — gère aussi les pilotes' },
      ], { name: 'role', value: user.role })),
      field('Compte actif', h('input', { type: 'checkbox', name: 'active', checked: !!user.active })),
    ]);
    if (!values) return;
    try { await put(`/admin/users/${user.id}`, values); toast('Pilote mis à jour.'); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  return panel('Pilotes', { count: users.length, flush: true },
    table([{ label: 'Pilote' }, { label: 'Rôle' }, { label: 'Runs', num: true },
      { label: 'Dernière visite' }, { label: 'État' }, { label: '' }],
    users,
    (u) => h('tr', { class: u.active ? null : 'is-off' },
      h('td', h('strong', u.callsign || u.display_name || u.username),
        u.callsign ? h('em.hint', u.display_name || u.username) : null),
      h('td', h(`span.tag${u.role === 'admin' ? '.tag--admin' : u.role === 'officer' ? '.tag--officer' : ''}`,
        { }, u.role === 'admin' ? 'Administrateur' : u.role === 'officer' ? 'Officier' : 'Pilote')),
      h('td', { class: 'num' }, num(u.runs)),
      h('td', u.last_login_at ? ago(u.last_login_at) : h('em.hint', 'jamais')),
      h('td', u.active ? 'Actif' : h('em.hint', 'Désactivé')),
      rowActions(editBtn(() => edit(u))),
    )),
  );
}

/* ====================================================== synchronisation */

async function syncPane(ctx) {
  const logs = await get('/admin/sync/log');

  const runNow = async (btn) => {
    btn.disabled = true;
    btn.textContent = 'Relevé en cours…';
    try {
      const r = await post('/admin/sync/run');
      toast(`Relevé terminé : ${num(r.stations ?? r.stations_seen ?? 0)} stations.`);
      ctx.reload();
    } catch (e) {
      notifyError(e);
      btn.disabled = false;
      btn.textContent = 'Lancer un relevé';
    }
  };

  const STATUS = { ok: 'Terminé', partial: 'Partiel', error: 'Échec', running: 'En cours' };

  return panel('Relevés de l\'API darkstat', {
    count: logs.length, flush: true,
    tools: h('button.btn.btn--primary.btn--sm', { type: 'button', onClick: (e) => runNow(e.target) },
      'Lancer un relevé'),
  },
  logs.length
    ? table([{ label: 'Début' }, { label: 'Durée' }, { label: 'État' },
      { label: 'Stations', num: true }, { label: 'Lignes', num: true }, { label: 'Message' }],
    logs,
    (l) => h('tr', { class: l.status === 'error' ? 'is-low' : null },
      h('td', dateShort(l.started_at)),
      h('td', l.finished_at ? `${Math.max(0, Math.round(
        (Date.parse(l.finished_at.replace(' ', 'T') + 'Z') -
         Date.parse(l.started_at.replace(' ', 'T') + 'Z')) / 1000))} s` : '—'),
      h('td', STATUS[l.status] || l.status),
      h('td', { class: 'num' }, num(l.stations_seen)),
      h('td', { class: 'num' }, num(l.rows_written)),
      h('td', h('em.hint', l.message || '')),
    ))
    : empty('Aucun relevé',
      'Le premier relevé part au démarrage du serveur. Vous pouvez aussi en déclencher un maintenant.'),
  );
}

const PANES = {
  stations: stationsPane,
  thresholds: thresholdsPane,
  missions: missionsPane,
  items: itemsPane,
  routes: routesPane,
  recipes: recipesPane,
  users: usersPane,
  sync: syncPane,
};
