/* =====================================================================
   Vues accessibles à tout pilote connecté.
   ===================================================================== */

import {
  h, get, post, num, signed, ago, dateShort, gauge, toast, notifyError,
  modal, confirmDialog, field, input, select, loading, empty, panel, clear,
} from './ui.js';
import { t, t2 } from './i18n.js';

const PRIORITES = ['critical', 'high', 'normal', 'low'];

/* ===================================================== tableau de missions */

export async function missionsView(ctx) {
  const state = ctx.filters ||= { station: '', direction: '' };
  const [stations, missions] = await Promise.all([
    get('/stations'),
    get(`/missions?station=${state.station}&direction=${state.direction}`),
  ]);

  const body = h('div.grid.grid--missions');

  const render = (list) => {
    clear(body);
    if (!list.length) {
      body.appendChild(empty(t('missions.empty'), t('missions.emptyHint')));
      return;
    }
    // Le plus urgent d'abord : c'est ce qu'un pilote qui décolle veut voir.
    const tri = [...list].sort((a, b) =>
      PRIORITES.indexOf(a.priority) - PRIORITES.indexOf(b.priority) ||
      (b.target_qty - b.pledged_qty) - (a.target_qty - a.pledged_qty));
    for (const m of tri) body.appendChild(missionCard(m, ctx));
  };

  const onFilter = async () => {
    body.replaceChildren(loading(t('common.loading')));
    try {
      render(await get(`/missions?station=${state.station}&direction=${state.direction}`));
    } catch (e) { notifyError(e); }
  };

  const toolbar = h('div.toolbar',
    select(
      [{ value: '', label: t('missions.allStations') },
        ...stations.map((s) => ({ value: s.id, label: s.name }))],
      { value: state.station, onChange: (e) => { state.station = e.target.value; onFilter(); } },
    ),
    h('div.tabs',
      ...[['', t('missions.filterAll')],
        ['import', t('missions.filterImport')],
        ['export', t('missions.filterExport')]].map(([value, label]) =>
        h('button.chip', {
          type: 'button',
          class: state.direction === value ? 'is-on' : null,
          onClick: (e) => {
            state.direction = value;
            for (const c of e.target.parentElement.children) c.classList.remove('is-on');
            e.target.classList.add('is-on');
            onFilter();
          },
        }, label)),
    ),
  );

  render(missions);
  return h('div',
    h('div.head', h('span.eyebrow', t('missions.eyebrow')), h('h1', t('missions.title'))),
    toolbar,
    body,
  );
}

/**
 * Carte de mission.
 *
 * Hiérarchie voulue : ce qu'il faut transporter, où, combien il reste, et
 * ce que ça rapporte. La criticité porte la couleur ; le bouton d'action
 * reste neutre pour ne pas concurrencer ce signal.
 */
function missionCard(m, ctx) {
  const restant = Math.max(0, m.target_qty - m.pledged_qty);
  const cible = m.direction === 'import' ? m.max_stock : m.min_stock;
  const avancement = m.target_qty > 0
    ? Math.min(100, Math.round((m.pledged_qty / m.target_qty) * 100)) : 0;

  const volume = Number(m.item_volume) > 0 ? Number(m.item_volume) : 1;
  const primeMission = Number(m.reward_multiplier) > 0 ? Number(m.reward_multiplier) : 1;
  const primeItem = Number(m.risk_bonus) > 0 ? Number(m.risk_bonus) : 1;
  const prime = primeMission * primeItem;
  const parUnite = volume * prime;
  const complete = restant <= 0;

  const actions = h('div.mission__actions');
  if (m.my_claim_id) {
    actions.append(
      h('button.btn.btn--go', { type: 'button', onClick: () => deliverFlow(m, ctx) },
        t('mission.deliver')),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => abandonFlow(m, ctx) },
        t('mission.abandon')),
    );
  } else if (complete) {
    // Mission déjà entièrement couverte : la prendre ne servirait à rien.
    actions.append(h('span.mission__full', t('mission.full')));
  } else {
    actions.append(
      h('button.btn.btn--steel', { type: 'button', onClick: () => claimFlow(m, ctx) },
        t('mission.take')),
    );
  }

  return h('article.mission', { dataset: { priority: m.priority, dir: m.direction } },

    h('header.mission__bar',
      h('span.mission__way', t(`dir.${m.direction}Short`)),
      h('span.spacer'),
      m.auto ? h('span.tag.tag--auto', t('mission.auto')) : null,
      h('span.mission__prio', t(`priority.${m.priority}`)),
      m.pledged_qty > 0 ? h('span.mission__pct', `${avancement}%`) : null,
    ),

    h('div.mission__body',
      h('div.mission__lead',
        h('h3.mission__item', m.item_name),
        h('p.mission__where',
          `${t(`dir.${m.direction}`)} `, h('b', m.station_name),
          m.origin ? h('em', ` · ${t('mission.loadAt')} ${m.origin}`)
            : (m.vendor_hint ? h('em', ` · ${m.vendor_hint}`) : null)),
      ),

      // Le chiffre que le pilote cherche vraiment : combien reste-t-il.
      h('div.mission__need',
        h('span.mission__needLabel', t('mission.remaining')),
        h('strong.mission__needQty', num(restant)),
        h('span.mission__needUnit', t('common.unit')),
      ),
    ),

    gauge({ qty: m.current_qty, min: m.min_stock, max: m.max_stock }),

    h('div.mission__figures',
      figure(t('mission.inHold'), num(m.current_qty)),
      figure(t('mission.target'), num(cible)),
      figure(t('mission.volume'), `\u00d7${volume}`, null, t('mission.perUnit')),
      figure(t('mission.pledged'), num(m.pledged_qty), m.pledged_qty >= m.target_qty ? 'ok' : null),
    ),

    h('div.mission__reward',
      h('span.mission__rewardMain', t('mission.pointsFor', { v: num(m.target_qty * parUnite) })),
      h('span.mission__rewardRate', t('mission.rate', { v: parUnite })),
      prime !== 1 ? h('span.tag.tag--bonus', t('mission.riskBonus', { v: +prime.toFixed(2) })) : null,
    ),

    m.claimants.length
      ? h('div.crew', m.claimants.map((c) => h('span.chip', { class: c.mine ? 'is-me' : null,
        title: `${num(c.pledged)} ${t('common.units')}` },
      c.name, c.pledged ? h('b', ` ${num(c.pledged)}`) : null)))
      : h('div.crew.crew__none', t('mission.nobody')),

    actions,
  );
}

const figure = (label, value, tone = null, sub = null) =>
  h('div.figure', { class: tone ? `is-${tone}` : null },
    h('span', label), h('b', value), sub ? h('i', sub) : null);

/* ------------------------------------------------------------- actions */

async function claimFlow(m, ctx) {
  const restant = Math.max(0, m.target_qty - m.pledged_qty);
  if (restant <= 0) { toast(t('mission.full'), 'err'); return; }

  // Le champ est plafonné à ce qui reste : s'engager au-delà n'a pas de sens.
  const champ = input({ type: 'number', name: 'pledged', min: '1', step: '1',
    max: String(restant), value: restant, class: 'input--num' });

  const value = await modal({
    title: t('claim.title'),
    build: () => h('div',
      h('p', { style: 'margin-top:0' },
        `${t(`dir.${m.direction}Short`)} \u2014 `, h('strong', m.item_name), ` \u00b7 ${m.station_name}`),
      field(t('claim.qtyLabel'), champ,
        `${t('mission.freeLeft', { v: num(restant) })} \u00b7 ${t('claim.qtyHint')}`),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('claim.confirm'), variant: 'primary',
        onClick: (c) => c(Math.min(restant, Math.max(1, Number(champ.value) || 0))) },
    ],
  });

  if (value == null) return;
  try {
    await post(`/missions/${m.id}/claim`, { pledged: value });
    toast(t('claim.done'));
    ctx.reload();
  } catch (e) { notifyError(e); }
}

async function deliverFlow(m, ctx) {
  const mien = m.claimants?.find((c) => c.mine);
  const champ = input({ type: 'number', name: 'quantity', min: '0', step: '1',
    value: mien?.pledged || m.target_qty, class: 'input--num' });
  const note = input({ name: 'note', placeholder: t('common.optional') });

  const result = await modal({
    title: t('deliver.title'),
    build: () => h('div',
      h('p', { style: 'margin-top:0' }, h('strong', m.item_name), ` \u00b7 ${m.station_name}`),
      field(t('deliver.qtyLabel'), champ, t('deliver.qtyHint')),
      field(t('common.note'), note),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('deliver.confirm'), variant: 'go',
        onClick: (c) => c({ quantity: Number(champ.value) || 0, note: note.value || null }) },
    ],
  });

  if (!result) return;
  try {
    const r = await post(`/claims/${m.my_claim_id}/deliver`, result);
    toast(t('deliver.done', { v: num(result.quantity), p: num(r.points ?? 0) }));
    ctx.reload();
  } catch (e) { notifyError(e); }
}

async function abandonFlow(m, ctx) {
  if (!await confirmDialog(t('abandon.title'),
    t('abandon.body', { item: m.item_name }), t('abandon.confirm'))) return;
  try {
    await post(`/claims/${m.my_claim_id}/abandon`);
    toast(t('abandon.done'));
    ctx.reload();
  } catch (e) { notifyError(e); }
}

/* ============================================================ mes runs */

export async function mineView(ctx) {
  const [claims, history] = await Promise.all([
    get('/missions/mine'),
    get('/missions/history'),
  ]);

  const enCours = claims.length
    ? panel(t('mine.active'), { count: claims.length, flush: true },
      h('table.table',
        h('thead', h('tr', ...[t('mine.colGoods'), t('mine.colDir'), t('mine.colStation'),
          t('mine.colPledged'), t('mine.colWorth'), t('mine.colSince'), ''].map((x) => h('th', x)))),
        h('tbody', claims.map((c) => h('tr',
          h('td', h('strong', c.item_name)),
          h('td', h(`span.way.way--${c.direction}`, t(`dir.${c.direction}Short`))),
          h('td', c.station_name),
          h('td', { class: 'num' }, num(c.pledged_qty)),
          h('td', { class: 'num is-ok', title: t('mine.estimated') },
            `${num(c.pledged_qty * (Number(c.item_volume) || 1)
              * (Number(c.reward_multiplier) || 1) * (Number(c.risk_bonus) || 1))} ${t('common.points')}`),
          h('td', { class: 'num' }, t('common.ago', { v: ago(c.claimed_at) })),
          h('td', { class: 'row-actions' },
            h('button.btn.btn--go.btn--sm', { type: 'button',
              onClick: () => deliverFlow({ ...c, id: c.mission_id, my_claim_id: c.claim_id,
                claimants: [{ mine: true, pledged: c.pledged_qty }], target_qty: c.pledged_qty }, ctx) },
            t('mission.deliver')),
            h('button.btn.btn--ghost.btn--sm', { type: 'button',
              onClick: () => abandonFlow({ ...c, my_claim_id: c.claim_id }, ctx) },
            t('mission.abandon')),
          ),
        ))),
      ))
    : empty(t('mine.empty'), t('mine.emptyHint'),
      h('a.btn.btn--steel', { href: '#/missions' }, t('mine.goToMissions')));

  const passe = history.length
    ? panel(t('mine.history'), { count: history.length, flush: true },
      h('table.table',
        h('thead', h('tr', ...[t('mine.colGoods'), t('mine.colStation'), t('mine.colDelivered'),
          t('mine.colPoints'), t('mine.colWhen'), t('mine.colStatus'), ''].map((x) => h('th', x)))),
        h('tbody', history.map((r) => h('tr', { class: r.status === 'delivered' ? null : 'is-off' },
          h('td', h('strong', r.item_name),
            r.cancel_reason ? h('em.hint', r.cancel_reason) : null),
          h('td', r.station_name),
          h('td', { class: 'num' }, r.status === 'delivered' ? num(r.delivered_qty) : '\u2014'),
          h('td', { class: 'num' }, r.points ? num(r.points) : '\u2014'),
          h('td', { class: 'num' }, dateShort(r.closed_at)),
          h('td', h(`span.tag.tag--${r.status}`, t(`status.${r.status}`)),
            r.cancelled_by_callsign
              ? h('em.hint', t('cancel.by', { who: r.cancelled_by_callsign })) : null),
          h('td', { class: 'row-actions' },
            r.status === 'delivered'
              ? h('button.btn.btn--ghost.btn--sm', { type: 'button',
                onClick: () => cancelFlow(r, ctx) }, t('common.delete'))
              : null),
        ))),
      ))
    : panel(t('mine.history'), {}, empty(t('mine.historyEmpty'), t('mine.historyEmptyHint')));

  return h('div',
    h('div.head', h('span.eyebrow', t('mine.eyebrow')), h('h1', t('mine.title'))),
    enCours,
    passe,
  );
}

/**
 * Annulation d'une livraison : retire les unités de la soute et les points
 * du classement. C'est la sortie de secours pour un essai ou une erreur.
 */
async function cancelFlow(r, ctx) {
  const motif = input({ name: 'reason', placeholder: t('common.optional') });

  const ok = await modal({
    title: t('cancel.title'),
    build: () => h('div',
      h('p', { style: 'margin-top:0' }, t('cancel.body', {
        qty: num(r.delivered_qty), station: r.station_name, pts: num(r.points),
      })),
      field(t('cancel.reason'), motif, t('cancel.reasonHint')),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('cancel.confirm'), variant: 'danger',
        onClick: (c) => c({ reason: motif.value.trim() || null }) },
    ],
  });

  if (!ok) return;
  try {
    await post(`/claims/${r.claim_id}/cancel`, ok);
    toast(t('cancel.done'));
    ctx.reload();
  } catch (e) { notifyError(e); }
}

/* ============================================================== soutes */

export async function stationsView(ctx) {
  const stations = await get('/stations');
  if (!stations.length) {
    return h('div',
      h('div.head', h('span.eyebrow', t('stations.eyebrow')), h('h1', t('stations.title'))),
      empty(t('stations.empty'), t('stations.emptyHint')),
    );
  }

  return h('div',
    h('div.head', h('span.eyebrow', t('stations.eyebrow')), h('h1', t('stations.title'))),
    h('div.grid.grid--stations', stations.map((s) => stationCard(s))),
  );
}

function stationCard(s) {
  const coque = s.health == null ? null : Math.round(s.health * (s.health <= 1 ? 100 : 1));
  return h('article.station', { onClick: () => openInventory(s), tabindex: '0',
    onKeydown: (e) => { if (e.key === 'Enter') openInventory(s); } },
  h('div.station__top',
    h('span.station__code', s.code),
    h('h3.station__name', s.name),
    s.shortages > 0
      ? h('span.tag.is-low', t('stations.shortages', { n: s.shortages }))
      : h('span.tag.is-ok', t('stations.onTarget')),
  ),
  h('div.station__vitals',
    vital(t('stations.hull'), coque == null ? '\u2014' : `${coque} %`),
    vital(t('stations.funds'), s.money == null ? '\u2014' : num(s.money)),
    vital(t('stations.hold'), s.cargospace == null ? '\u2014' : num(s.cargospace)),
    vital(t('stations.lines'), num(s.item_count)),
  ),
  h('p.hint', t('stations.readAt', { v: ago(s.synced_at) })),
  );
}

const vital = (label, value) => h('div.vital', h('span', label), h('b', value));

async function openInventory(station) {
  await modal({
    title: station.name,
    width: '880px',
    build: () => {
      const host = h('div', loading(t('common.loading')));
      get(`/stations/${station.id}/inventory`).then(({ inventory }) => {
        clear(host);
        if (!inventory.length) {
          host.appendChild(empty(t('stations.emptyHold'), t('stations.emptyHoldHint')));
          return;
        }
        host.appendChild(h('table.table',
          h('thead', h('tr', ...[t('stations.colGoods'), t('stations.colLevel'),
            t('stations.colQty'), t('stations.colMin'), t('stations.colMax')].map((x) => h('th', x)))),
          h('tbody', inventory.map((r) => h('tr', { class: `lvl-${r.level}` },
            h('td', r.name, r.is_export ? h('span.tag.tag--out', t('dir.exportShort')) : null),
            h('td', { style: 'width:32%' }, gauge({
              qty: r.effective_qty, min: r.min_stock, max: r.max_stock, pending: r.pending_qty,
            })),
            h('td', { class: 'num' }, num(r.effective_qty),
              r.pending_qty ? h('em.hint', t('stations.pendingPart', { v: signed(r.pending_qty) })) : null),
            h('td', { class: 'num' }, num(r.min_stock)),
            h('td', { class: 'num' }, num(r.max_stock)),
          ))),
        ));
      }).catch((e) => { clear(host); host.appendChild(empty(t('common.failed'), e.message)); });
      return host;
    },
    actions: [{ label: t('common.close'), value: null }],
  });
}

/* =========================================================== armurerie */

export async function recipesView() {
  const { recipes, stations } = await get('/recipes');
  if (!recipes.length) {
    return h('div',
      h('div.head', h('span.eyebrow', t('recipes.eyebrow')), h('h1', t('recipes.title'))),
      empty(t('recipes.empty'), t('recipes.emptyHint')),
    );
  }

  const search = input({ type: 'search', placeholder: t('recipes.search') });
  const list = h('div');

  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(list);
    const shown = recipes.filter((r) =>
      !q || r.name.toLowerCase().includes(q) ||
      r.components.some((c) => c.name.toLowerCase().includes(q)));

    if (!shown.length) { list.appendChild(empty(t('recipes.noMatch'), t('recipes.noMatchHint'))); return; }
    for (const r of shown) list.appendChild(recipePanel(r, stations));
  };

  search.addEventListener('input', render);
  render();

  return h('div',
    h('div.head', h('span.eyebrow', t('recipes.eyebrow')), h('h1', t('recipes.title'))),
    h('div.toolbar', search),
    list,
  );
}

function recipePanel(recipe, stations) {
  const manquants = recipe.components.filter((c) =>
    !stations.some((s) => (c.stocks[s.code] ?? 0) >= c.quantity)).length;

  return panel(recipe.name, {
    count: recipe.components.length,
    flush: true,
    tools: manquants
      ? h('span.tag.is-low', t2('recipes.missing', manquants))
      : h('span.tag.is-ok', t('recipes.buildable')),
  },
  h('table.table',
    h('thead', h('tr',
      h('th', t('recipes.colComponent')),
      h('th', { class: 'num' }, t('recipes.colNeeded')),
      ...stations.map((s) => h('th', { class: 'num', title: s.name }, s.code)),
      h('th', t('recipes.colWhere')),
    )),
    h('tbody', recipe.components.map((c) => h('tr',
      h('td', c.name),
      h('td', { class: 'num' }, num(c.quantity)),
      ...stations.map((s) => {
        const q = c.stocks[s.code] ?? 0;
        const tone = q >= c.quantity ? 'ok' : (q > 0 ? 'low' : 'empty');
        return h('td', { class: `num is-${tone}` }, num(q));
      }),
      h('td', h('em.hint', c.vendorHint || t('recipes.unknownOrigin'))),
    ))),
  ));
}

/* ============================================================== routes */

export async function routesView() {
  const routes = await get('/routes');
  if (!routes.length) {
    return h('div',
      h('div.head', h('span.eyebrow', t('routes.eyebrow')), h('h1', t('routes.title'))),
      empty(t('routes.empty'), t('routes.emptyHint')),
    );
  }

  const lanes = new Map();
  for (const r of routes) {
    const from = r.source_name || r.source_label || t('routes.external');
    const key = `${from}\u0000${r.dest_name}`;
    if (!lanes.has(key)) lanes.set(key, { from, to: r.dest_name, goods: [] });
    lanes.get(key).goods.push(r.item_name);
  }

  return h('div',
    h('div.head', h('span.eyebrow', t('routes.eyebrow')), h('h1', t('routes.title'))),
    h('div', [...lanes.values()].map((lane) =>
      panel(`${lane.from} \u2192 ${lane.to}`, { count: lane.goods.length },
        h('div.crew', lane.goods.map((g) => h('span.chip', g))),
      ))),
  );
}

/* ========================================================== classement */

export async function boardView(ctx) {
  const periode = ctx.boardPeriod ||= 'month';
  const { rows, funds } = await get(`/leaderboard?period=${periode}`);

  const table = h('div.board');
  if (!rows.length) {
    table.appendChild(empty(t('board.empty'), t('board.emptyHint')));
  } else {
    const tete = rows[0].points || 1;
    rows.forEach((r, i) => table.appendChild(h('div.board__row', { class: i < 3 ? 'is-podium' : null },
      h('span.board__rank', String(i + 1).padStart(2, '0')),
      h('strong.board__name', r.callsign || r.display_name),
      // Barre proportionnelle au meneur : le classement se lit sans comparer
      // mentalement des nombres à cinq chiffres.
      h('span.board__bar', h('i', { style: `width:${Math.round((r.points / tete) * 100)}%` })),
      h('span.board__runs', t2('board.runs', r.runs)),
      h('span.board__units', { title: t('board.unitsHauled', { v: num(r.units) }) },
        `${num(r.points)} ${t('common.points')}`),
    )));
  }

  return h('div',
    h('div.head', h('span.eyebrow', t('board.eyebrow')), h('h1', t('board.title'))),

    // La cagnotte d'abord : c'est elle qui donne son sens au classement.
    fundsBanner(funds),

    h('div.toolbar', h('div.tabs',
      ...[['month', t('board.month')], ['last', t('board.lastMonth')], ['year', t('board.year')]]
        .map(([value, label]) => h('button.chip', {
          type: 'button',
          class: periode === value ? 'is-on' : null,
          onClick: () => { ctx.boardPeriod = value; ctx.reload(); },
        }, label))),
    ),

    h('p.hint', { style: 'margin:0 0 1rem;max-width:64ch' }, t('board.explain')),
    table,
  );
}

/**
 * Cagnotte du mois.
 *
 * L'API ne donne que le solde courant des stations : la variation se mesure
 * contre le premier relevé du mois. Tant qu'il n'existe pas, on affiche le
 * total sans prétendre connaître le gain.
 */
function fundsBanner(funds) {
  if (!funds) return null;
  return h('section.pot',
    h('div.pot__main',
      h('span.pot__label', t('board.gained')),
      h('strong.pot__value', { class: funds.delta >= 0 ? 'is-up' : 'is-down' },
        funds.hasBaseline ? signed(funds.delta) : num(funds.total)),
      h('span.pot__unit', 'cr'),
    ),
    h('div.pot__side',
      h('span.hint', funds.hasBaseline
        ? `${t('board.funds')} : ${num(funds.total)} cr`
        : t('board.noBaseline')),
      h('span.hint', t('board.payoutNote')),
    ),
    h('div.pot__stations', funds.stations.map((s) =>
      h('span.chip', { title: s.name }, s.code, h('b', ` ${num(s.money)}`)))),
  );
}
