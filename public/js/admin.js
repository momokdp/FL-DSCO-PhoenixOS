/* =====================================================================
   Console de gestion.
   Tout ce qui se paramètre se paramètre ici : plus aucun aller-retour
   vers un tableur ou un dépôt de code pour ajouter une station.
   ===================================================================== */

import {
  h, get, post, put, del, num, ago, dateShort, toast, notifyError, modal,
  confirmDialog, field, input, select, loading, empty, panel, clear, readForm,
} from './ui.js';
import { t, t2 } from './i18n.js';

const TABS = [
  { key: 'stations', label: t('adm.tab.stations'), role: 'officer' },
  { key: 'thresholds', label: t('adm.tab.thresholds'), role: 'officer' },
  { key: 'missions', label: t('adm.tab.missions'), role: 'officer' },
  { key: 'runs', label: t('adm.tab.runs'), role: 'officer' },
  { key: 'items', label: t('adm.tab.items'), role: 'officer' },
  { key: 'routes', label: t('adm.tab.routes'), role: 'officer' },
  { key: 'users', label: t('adm.tab.users'), role: 'admin' },
  { key: 'sync', label: t('adm.tab.sync'), role: 'officer' },
];

const RANK = { member: 0, officer: 1, admin: 2 };

export async function adminView(ctx) {
  const allowed = TABS.filter((tab) => RANK[ctx.user.role] >= RANK[tab.role]);
  const state = ctx.adminTab && allowed.some((tab) => tab.key === ctx.adminTab)
    ? ctx.adminTab : allowed[0].key;

  const stage = h('div', loading());

  const open = async (key) => {
    ctx.adminTab = key;
    for (const btn of tabs.children) btn.classList.toggle('is-on', btn.dataset.key === key);
    stage.replaceChildren(loading());
    try {
      stage.replaceChildren(await PANES[key](ctx));
    } catch (e) {
      stage.replaceChildren(empty(t('common.failed'), e.message));
    }
  };

  const tabs = h('div.tabs', allowed.map((tab) =>
    h('button.chip', {
      type: 'button', dataset: { key: tab.key },
      class: tab.key === state ? 'is-on' : null,
      onClick: () => open(tab.key),
    }, tab.label)));

  open(state);

  return h('div',
    h('div.head', h('span.eyebrow', t('adm.eyebrow')), h('h1', t('adm.title'))),
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
  h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick }, t('common.edit'));

const deleteBtn = (onClick) =>
  h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick }, t('common.delete'));

/* --------------------------------------------------- choix marchandise */

/**
 * Les marchandises ne se saisissent jamais à la main.
 *
 * Leur nom appartient à l'API darkstat : c'est lui qui rattache une mission
 * au relevé de stock de la station. Un champ libre laissait passer les
 * variantes de casse, les fautes de frappe et les noms inventés, qui
 * créaient une fiche fantôme sans stock. On propose donc la liste connue,
 * et rien d'autre ; elle s'enrichit au relevé, ou depuis l'onglet
 * Marchandises.
 */
const listeMarchandises = () => get('/admin/items?all=1');

const AIDE_MARCHANDISE = t('adm.item.help');

function itemSelect(items, props = {}) {
  return select([
    { value: '', label: t('adm.item.pick') },
    ...items.map((it) => ({ value: it.id, label: it.name })),
  ], { name: 'item_id', ...props });
}

/** Vrai si la liste est vide : sans elle, aucun formulaire n'a de sens. */
function refuserSansMarchandise(items) {
  if (items.length) return false;
  toast(t('adm.item.none'), 'err');
  return true;
}

/**
 * Ouvre un formulaire modal et renvoie les valeurs, ou null si annulé.
 *
 * `validate` renvoie un message quand la saisie ne va pas : la modale reste
 * alors ouverte. Signaler après fermeture ferait recommencer tout le
 * formulaire pour un menu resté sur son choix vide.
 */
function formModal(title, buildFields,
  { submitLabel = t('common.save'), width = null, validate = null } = {}) {
  let form;
  return modal({
    title, width,
    build: () => (form = h('div.form', buildFields())),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: submitLabel, variant: 'primary', onClick: (close) => {
        const values = readForm(form);
        const erreur = validate ? validate(values) : null;
        if (erreur) return toast(erreur, 'err');
        close(values);
      } },
    ],
  });
}

/** Refus commun aux formulaires dont la marchandise est obligatoire. */
const exigerMarchandise = (v) => (v.item_id ? null : t('adm.item.required'));

/* ============================================================ stations */

async function stationsPane(ctx) {
  const stations = await get('/admin/stations');

  const edit = async (station = null) => {
    const values = await formModal(station ? t('adm.st.edit') : t('adm.st.declare'), () => [
      field(t('adm.st.displayName'), input({ name: 'name', value: station?.name || '', required: true })),
      field(t('adm.st.apiName'), input({ name: 'api_name', value: station?.api_name || '' }),
        t('adm.st.apiNameHint')),
      field(t('adm.st.code'), input({ name: 'code', value: station?.code || '', maxlength: '5', placeholder: 'KOC' })),
      field(t('adm.col.system'), input({ name: 'system', value: station?.system || '' })),
      field(t('adm.st.order'), input({ type: 'number', name: 'sort_order', value: station?.sort_order ?? 0, class: 'input--num' })),
      field(t('adm.st.activeField'), h('input', { type: 'checkbox', name: 'active', checked: station ? !!station.active : true })),
    ]);
    if (!values) return;
    try {
      if (station) await put(`/admin/stations/${station.id}`, values);
      else await post('/admin/stations', values);
      toast(station ? t('adm.st.updated') : t('adm.st.declared'));
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const remove = async (station) => {
    if (!await confirmDialog(t('adm.st.delete'),
      t('adm.st.deleteBody', { name: station.name }),
      t('common.delete'))) return;
    try {
      await del(`/admin/stations/${station.id}`);
      toast(t('adm.st.deleted'));
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  return panel(t('adm.tab.stations'), {
    count: stations.length, flush: true,
    tools: addButton(t('adm.st.declare'), () => edit()),
  },
  stations.length
    ? table(
      [{ label: t('adm.col.code') }, { label: t('adm.col.name') }, { label: t('adm.col.apiName') }, { label: t('adm.col.system') },
        { label: t('adm.col.reading') }, { label: t('adm.col.state') }, { label: '' }],
      stations,
      (s) => h('tr', { class: s.active ? null : 'is-off' },
        h('td', h('span.station__code', s.code)),
        h('td', h('strong', s.name)),
        h('td', h('code', s.api_name)),
        h('td', s.system || '—'),
        h('td', s.synced_at ? ago(s.synced_at) : h('em.hint', t('adm.never'))),
        h('td', s.active ? t('adm.st.active') : h('em.hint', t('adm.st.disabled'))),
        rowActions(editBtn(() => edit(s)), ctx.user.role === 'admin' ? deleteBtn(() => remove(s)) : null),
      ))
    : empty(t('adm.st.empty'), t('adm.st.emptyHint'),
      addButton(t('adm.st.declare'), () => edit())),
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
    return panel(t('adm.tab.thresholds'), {}, empty(t('adm.st.empty'), t('adm.th.noStationHint')));
  }

  const state = ctx.seuilStation ||= String(stations[0].id);
  const filtre = input({ type: 'search', placeholder: t('adm.th.filter') });
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
    } catch (e) { host.replaceChildren(empty(t('adm.readFailed'), e.message)); }
  };

  const rendre = () => {
    const q = filtre.value.trim().toLowerCase();
    const lignes = inventaire.filter((r) => !q || r.name.toLowerCase().includes(q));
    // Les marchandises réglées remontent : ce sont celles qu'on revient voir.
    lignes.sort((a, b) => (b.has_custom | 0) - (a.has_custom | 0) || a.name.localeCompare(b.name));

    if (!lignes.length) {
      host.replaceChildren(empty(
        inventaire.length ? t('recipes.noMatch') : t('stations.emptyHold'),
        inventaire.length ? t('recipes.noMatchHint')
          : t('adm.th.needReading')));
      return;
    }

    host.replaceChildren(table(
      [{ label: t('adm.col.goods') }, { label: t('adm.col.way') }, { label: t('adm.col.inHold'), num: true },
        { label: t('adm.col.floor'), num: true }, { label: t('adm.col.ceiling'), num: true },
        { label: t('adm.col.bonus'), num: true }, { label: t('adm.col.api') }, { label: '' }],
      lignes,
      (r) => h('tr', { class: [r.has_custom ? 'is-custom' : '', r.is_hidden ? 'is-off' : ''].filter(Boolean).join(' ') || null },
        h('td', h('strong', r.name),
          r.threshold_note ? h('em.hint', r.threshold_note) : null),
        h('td',
          r.is_hidden
            ? h('span.way', { title: t('adm.th.hiddenTitle') }, t('adm.th.hidden'))
            : h(`span.way.way--${r.flow_mode || (r.is_export ? 'export' : 'import')}`,
              r.flow_mode === 'both' ? t('adm.th.both')
                : (r.flow_mode || (r.is_export ? 'export' : 'import')) === 'export'
                  ? t('adm.th.toCollect') : t('adm.th.toDeliver')),
          r.gate_item_id ? h('span.tag', { title: t('adm.th.gatedTitle') }, t('adm.th.gated')) : null),
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
      placeholder: t('adm.th.notePlaceholder') });
    const mode = select([
      { value: 'import', label: t('adm.th.modeImport') },
      { value: 'export', label: t('adm.th.modeExport') },
      { value: 'both', label: t('adm.th.modeBoth') },
    ], { name: 'flow_mode', value: r.flow_mode || (r.is_export ? 'export' : 'import') });

    const gateItem = select(
      [{ value: '', label: t('adm.th.noGate') },
        ...inventaire.filter((x) => x.item_id !== r.item_id)
          .map((x) => ({ value: x.item_id, label: x.name }))],
      { name: 'gate_item_id', value: r.gate_item_id ?? '' });

    const gateState = select([
      { value: 'full', label: t('adm.th.gateFull') },
      { value: 'low', label: t('adm.th.gateLow') },
    ], { name: 'gate_state', value: r.gate_state || 'full' });
    const masquer = h('input', { type: 'checkbox', name: 'is_hidden', checked: !!r.is_hidden });
    const prime = input({ type: 'number', name: 'risk_bonus', min: '0.1', max: '1000', step: '0.1',
      class: 'input--num', value: r.risk_bonus ?? 1 });
    const origine = input({ name: 'origin', value: r.origin || '',
      placeholder: t('adm.originPlaceholder') });
    const destination = input({ name: 'destination', value: r.destination || '',
      placeholder: t('adm.th.destPlaceholder') });

    const valeurs = await modal({
      title: r.name,
      build: () => h('div.form',
        h('p', { style: 'margin-top:0' },
          t('adm.th.apiValues', { min: num(r.api_min_stock), max: num(r.api_max_stock) })),
        field(t('adm.col.floor'), min, t('adm.th.floorHint')),
        field(t('adm.col.ceiling'), max, t('adm.th.ceilingHint')),
        field(t('adm.th.flow'), mode, t('adm.th.flowHint')),
        field(t('adm.th.gate'), gateItem, t('adm.th.gateHint')),
        field(t('adm.th.gateItem'), gateState),
        field(t('adm.th.originLabel'), origine, t('threshold.originHint')),
        field(t('adm.th.destLabel'), destination, t('threshold.destinationHint')),
        field(t('adm.th.bonus'), prime, t('adm.th.bonusHint')),
        field(t('adm.th.hide'), masquer, t('adm.th.hideHint')),
        field(t('common.note'), note),
      ),
      actions: [
        { label: t('common.cancel'), value: null },
        { label: t('common.save'), variant: 'primary', onClick: (close) => close({
          min_stock: min.value === '' ? null : Number(min.value),
          max_stock: max.value === '' ? null : Number(max.value),
          is_export: mode.value === 'export' ? 1 : 0,
          flow_mode: mode.value,
          gate_item_id: gateItem.value ? Number(gateItem.value) : null,
          gate_state: gateItem.value ? gateState.value : null,
          is_hidden: masquer.checked ? 1 : 0,
          risk_bonus: Number(prime.value) || 1,
          origin: origine.value.trim() || null,
          destination: destination.value.trim() || null,
          note: note.value.trim() || null,
        }) },
      ],
    });

    if (!valeurs) return;
    try {
      await put(`/admin/stations/${ctx.seuilStation}/thresholds/${r.item_id}`, valeurs);
      toast(t('adm.th.saved'));
      charger();
    } catch (e) { notifyError(e); }
  };

  const lever = async (r) => {
    if (!await confirmDialog(t('adm.th.reset'),
      t('adm.th.resetBody', { name: r.name, min: num(r.api_min_stock), max: num(r.api_max_stock) }),
      t('adm.th.resetConfirm'))) return;
    try {
      await put(`/admin/stations/${ctx.seuilStation}/thresholds/${r.item_id}`,
        { min_stock: null, max_stock: null, is_export: 0, is_hidden: 0, flow_mode: null,
          gate_item_id: null, gate_state: null,
          risk_bonus: 1, origin: null, destination: null, note: null });
      toast(t('adm.th.resetDone'));
      charger();
    } catch (e) { notifyError(e); }
  };

  let minuteur;
  filtre.addEventListener('input', () => { clearTimeout(minuteur); minuteur = setTimeout(rendre, 200); });
  charger();

  return panel(t('adm.th.title'), { flush: true, tools: choix },
    h('div', { style: 'padding:.75rem 1rem 0' }, filtre),
    host,
  );
}

/* ============================================================ missions */

async function missionsPane(ctx) {
  const [stations, missions, items] = await Promise.all([
    get('/stations'), get('/missions'), listeMarchandises(),
  ]);
  const manual = missions.filter((m) => !m.auto);
  const auto = missions.filter((m) => m.auto);

  const create = async () => {
    if (refuserSansMarchandise(items)) return;
    const values = await formModal(t('adm.ms.open'), () => [
      field(t('adm.col.station'), select(stations.map((s) => ({ value: s.id, label: s.name })), { name: 'station_id' })),
      field(t('adm.col.goods'), itemSelect(items), AIDE_MARCHANDISE),
      field(t('adm.col.way'), select([
        { value: 'import', label: t('adm.ms.dirImport') },
        { value: 'export', label: t('adm.ms.dirExport') },
      ], { name: 'direction' })),
      field(t('adm.ms.qty'), input({ type: 'number', name: 'target_qty', value: 0, class: 'input--num' })),
      field(t('adm.ms.origin'), input({ name: 'origin', placeholder: t('adm.originPlaceholder') })),
      field(t('adm.col.priority'), select([
        { value: 'normal', label: t('priority.normal') }, { value: 'high', label: t('priority.high') },
        { value: 'critical', label: t('priority.critical') }, { value: 'low', label: t('priority.low') },
      ], { name: 'priority' })),
      field(t('adm.ms.bonus'), input({ type: 'number', name: 'reward_multiplier',
        min: '0.1', max: '10', step: '0.1', value: '1', class: 'input--num' }),
      t('adm.ms.bonusHint')),
    ], { submitLabel: t('adm.ms.openConfirm'), validate: exigerMarchandise });
    if (!values) return;
    try {
      await post('/admin/missions', values);
      toast(t('adm.ms.opened'));
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const archive = async (m) => {
    if (!await confirmDialog(t('adm.ms.archiveTitle'),
      t('adm.ms.archiveBody', { item: m.item_name, station: m.station_name }), t('adm.ms.archive'))) return;
    try {
      await del(`/admin/missions/${m.id}`);
      toast(t('adm.ms.archived'));
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  const row = (m) => h('tr',
    h('td', h('strong', m.item_name)),
    h('td', m.station_name),
    h('td', m.direction === 'import' ? t('adm.ms.supply') : t('adm.ms.collection')),
    h('td', { class: 'num' }, num(m.target_qty)),
    h('td', { class: 'num' }, num(m.pledged_qty)),
    h('td', t2('adm.ms.pilots', m.claim_count)),
    rowActions(deleteBtn(() => archive(m))),
  );

  const cols = [{ label: t('adm.col.goods') }, { label: t('adm.col.station') }, { label: t('adm.col.way') },
    { label: t('adm.col.asked'), num: true }, { label: t('adm.col.pledged'), num: true }, { label: t('adm.col.crew') }, { label: '' }];

  return h('div',
    panel(t('adm.ms.manualTitle'), {
      count: manual.length, flush: true, tools: addButton(t('adm.ms.open'), create),
    },
    manual.length ? table(cols, manual, row)
      : empty(t('adm.ms.noManual'), t('adm.ms.noManualHint'),
        addButton(t('adm.ms.open'), create))),

    panel(t('adm.ms.autoTitle'), { count: auto.length, flush: true },
      auto.length
        ? table(cols, auto, row)
        : empty(t('adm.ms.noAuto'), t('adm.ms.noAutoHint'))),
  );
}

/* ================================================================ runs */

/**
 * Runs de tous les pilotes.
 *
 * Un pilote ne voit que les siens et n'annule que les siens. Quand l'un
 * d'eux saisit un tonnage fantaisiste, le stock effectif et le classement
 * du mois restent faux tant que personne ne peut y toucher. C'est le seul
 * écran où un officier retrouve le run d'un autre et le retire.
 *
 * « Retirer » ne veut pas dire effacer : la ligne reste dans l'historique
 * du pilote, marquée annulée, avec le motif et le nom de l'officier. Un run
 * qui disparaîtrait sans laisser de trace ressemblerait à un bug.
 */
async function runsPane(ctx) {
  const state = ctx.runsFiltre ??= 'in_progress';
  const filtre = input({ type: 'search', placeholder: t('adm.runs.filter') });
  const host = h('div', loading());

  const STATUTS = [
    { value: 'in_progress', label: t('adm.runs.stActive') },
    { value: 'delivered', label: t('adm.runs.stDelivered') },
    { value: 'cancelled', label: t('adm.runs.stCancelled') },
    { value: 'abandoned', label: t('adm.runs.stAbandoned') },
    { value: '', label: t('adm.runs.stAll') },
  ];


  const choix = select(STATUTS, {
    value: state,
    onChange: (e) => { ctx.runsFiltre = e.target.value; charger(); },
  });

  let runs = [];

  const charger = async () => {
    host.replaceChildren(loading());
    try {
      const q = ctx.runsFiltre ? `?status=${encodeURIComponent(ctx.runsFiltre)}` : '';
      runs = await get(`/admin/claims${q}`);
      rendre();
    } catch (e) { host.replaceChildren(empty(t('adm.readFailed'), e.message)); }
  };

  /**
   * Retrait d'un run.
   *
   * Le motif est facultatif mais fortement souhaitable : c'est ce que le
   * pilote lira dans son historique pour comprendre ce qui lui est arrivé.
   */
  const retirer = async (r) => {
    const encours = r.status === 'in_progress';
    const motif = input({ name: 'reason', placeholder: t('adm.runs.reasonPlaceholder') });

    const confirme = await modal({
      title: encours ? t('adm.runs.pullTitle') : t('cancel.title'),
      build: () => h('div',
        h('p', { style: 'margin-top:0' },
          h('strong', r.callsign || r.display_name), ' · ',
          h('strong', r.item_name), ` · ${r.station_name}`),
        h('p.hint', encours
          ? t('adm.runs.pullPledge', { qty: num(r.pledged_qty) })
          : t('adm.runs.pullDelivery', { qty: num(r.delivered_qty), station: r.station_name, pts: num(r.points) })),
        field(t('cancel.reason'), motif, t('adm.runs.reasonHint')),
      ),
      actions: [
        { label: t('common.cancel'), value: null },
        { label: encours ? t('adm.runs.pull') : t('cancel.confirm'), variant: 'danger',
          onClick: (c) => c({ reason: motif.value.trim() || null }) },
      ],
    });

    if (!confirme) return;
    try {
      await post(`/admin/claims/${r.claim_id}/cancel`, confirme);
      toast(encours ? t('adm.runs.pulled') : t('cancel.done'));
      charger();
    } catch (e) { notifyError(e); }
  };

  const rendre = () => {
    const q = filtre.value.trim().toLowerCase();
    const lignes = runs.filter((r) => !q
      || `${r.callsign || ''} ${r.display_name || ''} ${r.item_name} ${r.station_name}`
        .toLowerCase().includes(q));

    if (!lignes.length) {
      host.replaceChildren(empty(
        runs.length ? t('recipes.noMatch') : t('adm.runs.empty'),
        runs.length ? t('recipes.noMatchHint')
          : t('adm.runs.emptyHint')));
      return;
    }

    host.replaceChildren(table(
      [{ label: t('adm.col.pilot') }, { label: t('adm.col.goods') }, { label: t('adm.col.station') }, { label: t('adm.col.way') },
        { label: t('adm.col.pledged'), num: true }, { label: t('adm.col.delivered'), num: true },
        { label: t('adm.col.points'), num: true }, { label: t('adm.col.when') }, { label: t('adm.col.state') }, { label: '' }],
      lignes,
      (r) => h('tr', { class: r.status === 'in_progress' || r.status === 'delivered' ? null : 'is-off' },
        h('td', h('strong', r.callsign || r.display_name),
          r.callsign ? h('em.hint', r.display_name) : null),
        h('td', r.item_name),
        h('td', r.station_name),
        h('td', h(`span.way.way--${r.direction}`,
          r.direction === 'import' ? t('adm.runs.deliver') : t('adm.runs.collect'))),
        h('td', { class: 'num' }, num(r.pledged_qty)),
        h('td', { class: 'num' }, r.status === 'delivered' ? num(r.delivered_qty) : '—'),
        h('td', { class: 'num' }, r.points ? num(r.points) : '—'),
        h('td', dateShort(r.closed_at || r.claimed_at)),
        h('td', t(`status.${r.status}`),
          // Qui a retiré le run et pourquoi, sur une seule ligne : c'est ce
          // que l'officier suivant lira avant de rouvrir le sujet.
          r.cancelled_by_callsign || r.cancel_reason
            ? h('em.hint', [r.cancelled_by_callsign ? t('adm.runs.by', { who: r.cancelled_by_callsign }) : null,
              r.cancel_reason].filter(Boolean).join(' · '))
            : null),
        rowActions(
          r.status === 'in_progress' || r.status === 'delivered'
            ? deleteBtn(() => retirer(r))
            : null),
      )));
  };

  filtre.addEventListener('input', () => runs.length && rendre());
  charger();

  return panel(t('adm.runs.title'), {
    flush: true,
    tools: h('span', { style: 'display:flex;gap:.5rem;align-items:center' }, choix, filtre),
  }, host);
}

/* ======================================================= marchandises */

async function itemsPane(ctx) {
  const search = input({ type: 'search', placeholder: t('adm.item.filter') });
  const host = h('div', loading());

  const load = async () => {
    host.replaceChildren(loading());
    try {
      const items = await get(`/admin/items?q=${encodeURIComponent(search.value.trim())}`);
      host.replaceChildren(items.length
        ? table(
          [{ label: t('adm.col.name') }, { label: t('adm.col.internalId') }, { label: t('adm.col.category') },
            { label: t('adm.col.whereToFind') }, { label: '' }],
          items,
          (it) => h('tr',
            h('td', h('strong', it.name)),
            h('td', it.commodity_id ? h('code', it.commodity_id) : h('em.hint', '—')),
            h('td', it.category),
            h('td', it.vendor_hint || h('em.hint', t('adm.item.notSet'))),
            rowActions(editBtn(() => edit(it)),
              ctx.user.role === 'admin' ? deleteBtn(() => remove(it)) : null),
          ))
        : empty(t('adm.item.empty'), t('adm.item.emptyHint')));
    } catch (e) { host.replaceChildren(empty(t('adm.readFailed'), e.message)); }
  };

  const edit = async (item = null) => {
    const values = await formModal(item ? t('adm.item.edit') : t('adm.item.add'), () => [
      field(t('adm.col.name'), input({ name: 'name', value: item?.name || '' }),
        t('adm.item.nameHint')),
      field(t('adm.col.internalId'), input({ name: 'commodity_id', value: item?.commodity_id || '' }),
        t('adm.item.idHint')),
      field(t('adm.col.category'), input({ name: 'category', value: item?.category || 'commodity' })),
      field(t('adm.col.whereToFind'), input({ name: 'vendor_hint', value: item?.vendor_hint || '' }),
        t('adm.item.whereHint')),
    ]);
    if (!values) return;
    try {
      if (item) await put(`/admin/items/${item.id}`, values);
      else await post('/admin/items', values);
      toast(t('adm.item.saved'));
      load();
    } catch (e) { notifyError(e); }
  };

  const remove = async (item) => {
    if (!await confirmDialog(t('adm.item.delete'),
      t('adm.item.deleteBody', { name: item.name }), t('common.delete'))) return;
    try { await del(`/admin/items/${item.id}`); toast(t('adm.item.deleted')); load(); }
    catch (e) { notifyError(e); }
  };

  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  load();

  return panel(t('adm.tab.items'), { flush: true, tools: addButton(t('adm.add'), () => edit()) },
    h('div', { style: 'padding:.75rem 1rem 0' }, search), host);
}

/* ============================================================== routes */

async function routesPane(ctx) {
  const [routes, stations, items] = await Promise.all([
    get('/admin/routes'), get('/stations'), listeMarchandises(),
  ]);

  const create = async () => {
    if (refuserSansMarchandise(items)) return;
    const values = await formModal(t('adm.rt.declare'), () => [
      field(t('adm.col.goods'), itemSelect(items), AIDE_MARCHANDISE),
      field(t('adm.rt.dest'),
        select(stations.map((s) => ({ value: s.id, label: s.name })), { name: 'dest_id' })),
      field(t('adm.rt.source'),
        select([{ value: '', label: t('adm.rt.outside') },
          ...stations.map((s) => ({ value: s.id, label: s.name }))], { name: 'source_id' })),
      field(t('adm.rt.outsideLabel'), input({ name: 'source_label', placeholder: t('adm.rt.outsidePlaceholder') })),
      field(t('adm.col.priority'), input({ type: 'number', name: 'priority', value: 0, class: 'input--num' })),
    ], { submitLabel: t('adm.rt.declareConfirm'), validate: exigerMarchandise });
    if (!values) return;
    try { await post('/admin/routes', values); toast(t('adm.rt.declared')); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  const remove = async (r) => {
    if (!await confirmDialog(t('adm.rt.delete'), t('adm.rt.deleteBody', { item: r.item_name, dest: r.dest_name }), t('common.delete'))) return;
    try { await del(`/admin/routes/${r.id}`); toast(t('adm.rt.deleted')); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  return panel(t('adm.rt.title'), {
    count: routes.length, flush: true, tools: addButton(t('adm.rt.declare'), create),
  },
  routes.length
    ? table([{ label: t('adm.col.goods') }, { label: t('adm.col.origin') }, { label: t('adm.col.destination') },
      { label: t('adm.col.priority'), num: true }, { label: '' }],
    routes,
    (r) => h('tr',
      h('td', h('strong', r.item_name)),
      h('td', r.source_name || h('em.hint', r.source_label || t('adm.rt.unspecified'))),
      h('td', r.dest_name),
      h('td', { class: 'num' }, num(r.priority)),
      rowActions(deleteBtn(() => remove(r))),
    ))
    : empty(t('adm.rt.empty'), t('adm.rt.emptyHint'),
      addButton(t('adm.rt.declare'), create)),
  );
}

/* ============================================================= pilotes */

async function usersPane(ctx) {
  const users = await get('/admin/users');

  const edit = async (user) => {
    const values = await formModal(user.display_name || user.username, () => [
      field(t('adm.us.callsign'), input({ name: 'callsign', value: user.callsign || '' }),
        t('adm.us.callsignHint')),
      field(t('adm.col.role'), select([
        { value: 'member', label: t('adm.us.roleMember') },
        { value: 'officer', label: t('adm.us.roleOfficer') },
        { value: 'admin', label: t('adm.us.roleAdmin') },
      ], { name: 'role', value: user.role })),
      field(t('adm.us.activeField'), h('input', { type: 'checkbox', name: 'active', checked: !!user.active })),
    ]);
    if (!values) return;
    try { await put(`/admin/users/${user.id}`, values); toast(t('adm.us.updated')); ctx.reload(); }
    catch (e) { notifyError(e); }
  };

  return panel(t('adm.tab.users'), { count: users.length, flush: true },
    table([{ label: t('adm.col.pilot') }, { label: t('adm.col.role') }, { label: t('adm.tab.runs'), num: true },
      { label: t('adm.col.lastVisit') }, { label: t('adm.col.state') }, { label: '' }],
    users,
    (u) => h('tr', { class: u.active ? null : 'is-off' },
      h('td', h('strong', u.callsign || u.display_name || u.username),
        u.callsign ? h('em.hint', u.display_name || u.username) : null),
      h('td', h(`span.tag${u.role === 'admin' ? '.tag--admin' : u.role === 'officer' ? '.tag--officer' : ''}`,
        { }, t(`role.${u.role}`))),
      h('td', { class: 'num' }, num(u.runs)),
      h('td', u.last_login_at ? ago(u.last_login_at) : h('em.hint', t('adm.never'))),
      h('td', u.active ? t('adm.us.active') : h('em.hint', t('adm.us.disabled'))),
      rowActions(editBtn(() => edit(u))),
    )),
  );
}

/* ====================================================== synchronisation */

async function syncPane(ctx) {
  const logs = await get('/admin/sync/log');

  const runNow = async (btn) => {
    btn.disabled = true;
    btn.textContent = t('adm.sync.running');
    try {
      const r = await post('/admin/sync/run');
      toast(t('adm.sync.done', { n: num(r.stations ?? r.stations_seen ?? 0) }));
      ctx.reload();
    } catch (e) {
      notifyError(e);
      btn.disabled = false;
      btn.textContent = t('adm.sync.run');
    }
  };

  /** Analyse du marché, à la demande : le cycle automatique est horaire. */
  const analyserRoutes = async (btn) => {
    btn.disabled = true;
    const libelle = btn.textContent;
    btn.textContent = t('adm.sync.analysing');
    try {
      const r = await post('/admin/routes/analyze');
      toast(r.trouvees
        ? t('adm.sync.routesFound', { found: num(r.trouvees), needs: num(r.analysees) })
        : t('adm.sync.routesNone'));
    } catch (e) {
      notifyError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = libelle;
    }
  };

  const STATUS = { ok: t('adm.sync.stOk'), partial: t('adm.sync.stPartial'), error: t('adm.sync.stError'), running: t('adm.sync.stRunning') };

  return panel(t('adm.sync.title'), {
    count: logs.length, flush: true,
    tools: h('span', { style: 'display:flex;gap:.5rem' },
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: (e) => analyserRoutes(e.target) },
        t('adm.sync.analyse')),
      h('button.btn.btn--primary.btn--sm', { type: 'button', onClick: (e) => runNow(e.target) },
        t('adm.sync.run'))),
  },
  logs.length
    ? table([{ label: t('adm.col.start') }, { label: t('adm.col.duration') }, { label: t('adm.col.state') },
      { label: t('adm.tab.stations'), num: true }, { label: t('adm.col.rows'), num: true }, { label: t('adm.col.message') }],
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
    : empty(t('adm.sync.empty'), t('adm.sync.emptyHint')),
  );
}

const PANES = {
  stations: stationsPane,
  thresholds: thresholdsPane,
  missions: missionsPane,
  runs: runsPane,
  items: itemsPane,
  routes: routesPane,
  users: usersPane,
  sync: syncPane,
};
