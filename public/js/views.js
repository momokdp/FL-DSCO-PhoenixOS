/* =====================================================================
   Vues accessibles à tout pilote connecté.
   Chaque vue exporte une fonction async qui renvoie un noeud à poser
   dans la scène. Le routeur s'occupe du reste.
   ===================================================================== */

import {
  h, get, post, num, signed, ago, dateShort, gauge, toast, notifyError,
  modal, confirmDialog, field, input, select, loading, empty, panel, clear,
} from './ui.js';

const DIR = {
  import: { label: 'Livrer à', verb: 'Approvisionnement', sign: 1 },
  export: { label: 'Retirer de', verb: 'Enlèvement', sign: -1 },
};

const PRIORITY = {
  critical: 'Critique', high: 'Haute', normal: 'Normale', low: 'Basse',
};

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
      body.appendChild(empty(
        'Aucune mission ouverte',
        'Les soutes sont au-dessus de leur seuil, ou aucun besoin n\'a encore été déclaré.',
      ));
      return;
    }
    for (const m of list) body.appendChild(missionCard(m, ctx));
  };

  const onFilter = async () => {
    body.replaceChildren(loading());
    try {
      render(await get(`/missions?station=${state.station}&direction=${state.direction}`));
    } catch (e) { notifyError(e); }
  };

  const toolbar = h('div.toolbar',
    select(
      [{ value: '', label: 'Toutes les soutes' },
        ...stations.map((s) => ({ value: s.id, label: s.name }))],
      { value: state.station, onChange: (e) => { state.station = e.target.value; onFilter(); } },
    ),
    h('div.tabs',
      ...[['', 'Tout'], ['import', 'À livrer'], ['export', 'À enlever']].map(([value, label]) =>
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
    h('div.head', h('span.eyebrow', 'Ordres de transport'), h('h1', 'Missions ouvertes')),
    toolbar,
    body,
  );
}

function missionCard(m, ctx) {
  const dir = DIR[m.direction];
  const remaining = Math.max(0, m.target_qty - m.pledged_qty);

  const actions = h('div.mission__actions');
  if (m.my_claim_id) {
    actions.append(
      h('button.btn.btn--go', { type: 'button', onClick: () => deliverFlow(m, ctx) }, 'Déclarer la livraison'),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => abandonFlow(m, ctx) }, 'Abandonner'),
    );
  } else {
    actions.append(
      h('button.btn.btn--primary', { type: 'button', onClick: () => claimFlow(m, ctx) }, 'Prendre la mission'),
    );
  }

  return h('article.mission', { dataset: { priority: m.priority } },
    h('div.mission__top',
      h(`span.mission__dir.mission__dir--${m.direction}`, dir.verb),
      m.auto ? h('span.tag.tag--auto', { title: 'Ouverte automatiquement sous le seuil bas' }, 'auto') : null,
      m.priority !== 'normal' ? h('span.tag', PRIORITY[m.priority]) : null,
    ),

    h('h3.mission__item', m.item_name),
    h('p.mission__where', `${dir.label} ${m.station_name}`,
      m.origin ? h('em', ` · charger : ${m.origin}`) : (m.vendor_hint ? h('em', ` · ${m.vendor_hint}`) : null)),

    gauge({ qty: m.current_qty, min: m.min_stock, max: m.max_stock }),

    h('div.mission__figures',
      figure('En soute', num(m.current_qty)),
      figure('Seuil bas', num(m.min_stock)),
      figure('Demandé', num(m.target_qty)),
      figure('Engagé', num(m.pledged_qty), m.pledged_qty >= m.target_qty ? 'ok' : null),
      figure('Restant', num(remaining)),
    ),

    m.claimants.length
      ? h('div.crew', m.claimants.map((c) => h('span.chip', { title: `${num(c.pledged)} unités engagées` },
        c.name, c.pledged ? h('b', ` ${num(c.pledged)}`) : null)))
      : h('div.crew.crew__none', 'Personne dessus'),

    actions,
  );
}

const figure = (label, value, tone = null) =>
  h('div.figure', { class: tone ? `is-${tone}` : null }, h('span', label), h('b', value));

/* ------------------------------------------------------------- actions */

async function claimFlow(m, ctx) {
  const remaining = Math.max(0, m.target_qty - m.pledged_qty);
  const qtyInput = input({ type: 'number', name: 'pledged', min: '0', step: '1',
    value: remaining || m.target_qty, class: 'input--num' });

  const value = await modal({
    title: 'Prendre la mission',
    build: () => h('div',
      h('p', { style: 'margin-top:0' },
        `${DIR[m.direction].verb} — `, h('strong', m.item_name), ` · ${m.station_name}`),
      field('Tonnage que vous vous engagez à transporter', qtyInput,
        'Indicatif : sert à éviter que trois pilotes chargent la même cargaison.'),
    ),
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Prendre', variant: 'primary', onClick: (close) => close(Number(qtyInput.value) || 0) },
    ],
  });

  if (value == null) return;
  try {
    await post(`/missions/${m.id}/claim`, { pledged: value });
    toast('Mission prise. Bon vol.');
    ctx.reload();
  } catch (e) { notifyError(e); }
}

async function deliverFlow(m, ctx) {
  const qtyInput = input({ type: 'number', name: 'quantity', min: '0', step: '1',
    value: m.claimants.find((c) => c.mine)?.pledged || m.target_qty, class: 'input--num' });
  const noteInput = input({ name: 'note', placeholder: 'Remarque (facultatif)' });

  const result = await modal({
    title: 'Déclarer la livraison',
    build: () => h('div',
      h('p', { style: 'margin-top:0' }, h('strong', m.item_name), ` · ${m.station_name}`),
      field('Tonnage réellement transporté', qtyInput,
        'Le stock est ajusté immédiatement, puis confirmé au prochain relevé de l\'API.'),
      field('Note', noteInput),
    ),
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Valider la livraison', variant: 'go',
        onClick: (close) => close({ quantity: Number(qtyInput.value) || 0, note: noteInput.value || null }) },
    ],
  });

  if (!result) return;
  try {
    await post(`/claims/${m.my_claim_id}/deliver`, result);
    toast(`Livraison enregistrée : ${signed(DIR[m.direction].sign * result.quantity)} unités.`);
    ctx.reload();
  } catch (e) { notifyError(e); }
}

async function abandonFlow(m, ctx) {
  const ok = await confirmDialog(
    'Abandonner la mission',
    `Votre engagement sur ${m.item_name} sera retiré. La mission reste ouverte pour les autres.`,
    'Abandonner',
  );
  if (!ok) return;
  try {
    await post(`/claims/${m.my_claim_id}/abandon`);
    toast('Engagement retiré.');
    ctx.reload();
  } catch (e) { notifyError(e); }
}

/* ============================================================ mes runs */

export async function mineView(ctx) {
  const claims = await get('/missions/mine');

  if (!claims.length) {
    return h('div',
      h('div.head', h('span.eyebrow', 'Carnet de bord'), h('h1', 'Mes runs')),
      empty('Aucun run en cours',
        'Prenez une mission depuis le tableau pour la voir apparaître ici.',
        h('a.btn.btn--primary', { href: '#/missions' }, 'Voir les missions')),
    );
  }

  const rows = claims.map((c) => h('tr',
    h('td', h('strong', c.item_name), c.vendor_hint ? h('em.hint', c.vendor_hint) : null),
    h('td', h(`span.mission__dir.mission__dir--${c.direction}`, DIR[c.direction].verb)),
    h('td', c.station_name),
    h('td', { class: 'num' }, num(c.pledged_qty)),
    h('td', { class: 'num' }, ago(c.claimed_at)),
    h('td',
      h('button.btn.btn--go.btn--sm', { type: 'button',
        onClick: () => deliverFlow({ ...c, id: c.mission_id, my_claim_id: c.claim_id, claimants: [], target_qty: c.pledged_qty }, ctx) },
      'Livrer'),
      h('button.btn.btn--ghost.btn--sm', { type: 'button',
        onClick: () => abandonFlow({ ...c, my_claim_id: c.claim_id }, ctx) }, 'Abandonner'),
    ),
  ));

  return h('div',
    h('div.head', h('span.eyebrow', 'Carnet de bord'), h('h1', 'Mes runs')),
    panel('Engagements en cours', { count: claims.length, flush: true },
      h('table.table',
        h('thead', h('tr', ...['Marchandise', 'Sens', 'Soute', 'Engagé', 'Depuis', ''].map((t) => h('th', t)))),
        h('tbody', rows),
      )),
  );
}

/* ============================================================== soutes */

export async function stationsView(ctx) {
  const stations = await get('/stations');

  if (!stations.length) {
    return h('div',
      h('div.head', h('span.eyebrow', 'Inventaire'), h('h1', 'Soutes')),
      empty('Aucune station enregistrée',
        'Un officier doit déclarer les stations depuis la gestion pour que la synchronisation les remplisse.'),
    );
  }

  return h('div',
    h('div.head', h('span.eyebrow', 'Inventaire'), h('h1', 'Soutes')),
    h('div.grid.grid--stations', stations.map((s) => stationCard(s, ctx))),
  );
}

function stationCard(s, ctx) {
  const health = s.health == null ? null : Math.round(s.health * (s.health <= 1 ? 100 : 1));
  return h('article.station', { onClick: () => openInventory(s, ctx), tabindex: '0',
    onKeydown: (e) => { if (e.key === 'Enter') openInventory(s, ctx); } },
  h('div.station__top',
    h('span.station__code', s.code),
    h('h3.station__name', s.name),
    s.shortages > 0
      ? h('span.tag.is-low', `${s.shortages} sous seuil`)
      : h('span.tag.is-ok', 'Seuils tenus'),
  ),
  h('div.station__vitals',
    vital('Coque', health == null ? '—' : `${health} %`),
    vital('Fonds', s.money == null ? '—' : num(s.money)),
    vital('Soute', s.cargospace == null ? '—' : num(s.cargospace)),
    vital('Références', num(s.item_count)),
  ),
  h('p.hint', `Relevé ${ago(s.synced_at)}`),
  );
}

const vital = (label, value) => h('div.vital', h('span', label), h('b', value));

async function openInventory(station, ctx) {
  await modal({
    title: station.name,
    width: '860px',
    build: (close) => {
      const host = h('div', loading());
      get(`/stations/${station.id}/inventory`).then(({ inventory }) => {
        clear(host);
        if (!inventory.length) {
          host.appendChild(empty('Soute vide',
            'Aucun relevé pour cette station. Vérifiez que son nom API correspond exactement à celui de darkstat.'));
          return;
        }
        host.appendChild(h('table.table',
          h('thead', h('tr', ...['Marchandise', 'Niveau', 'En soute', 'Seuil bas', 'Plafond'].map((t) => h('th', t)))),
          h('tbody', inventory.map((r) => h('tr', { class: `lvl-${r.level}` },
            h('td', r.name),
            h('td', { style: 'width:34%' }, gauge({
              qty: r.effective_qty, min: r.min_stock, max: r.max_stock, pending: r.pending_qty,
            })),
            h('td', { class: 'num' }, num(r.effective_qty),
              r.pending_qty ? h('em.hint', `dont ${signed(r.pending_qty)} en attente`) : null),
            h('td', { class: 'num' }, num(r.min_stock)),
            h('td', { class: 'num' }, num(r.max_stock)),
          ))),
        ));
      }).catch((e) => { clear(host); host.appendChild(empty('Lecture impossible', e.message)); });
      return host;
    },
    actions: [{ label: 'Fermer', value: null }],
  });
}

/* =========================================================== armurerie */

export async function recipesView() {
  const { recipes, stations } = await get('/recipes');

  if (!recipes.length) {
    return h('div',
      h('div.head', h('span.eyebrow', 'Fabrication'), h('h1', 'Armurerie')),
      empty('Aucune recette',
        'Importez le fichier de recettes Discovery depuis la gestion, ou saisissez-les à la main.'),
    );
  }

  const search = input({ type: 'search', placeholder: 'Filtrer par arme ou composant…' });
  const list = h('div');

  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(list);
    const shown = recipes.filter((r) =>
      !q || r.name.toLowerCase().includes(q) ||
      r.components.some((c) => c.name.toLowerCase().includes(q)));

    if (!shown.length) { list.appendChild(empty('Aucun résultat', 'Essayez un autre terme.')); return; }
    for (const r of shown) list.appendChild(recipePanel(r, stations));
  };

  search.addEventListener('input', render);
  render();

  return h('div',
    h('div.head', h('span.eyebrow', 'Fabrication'), h('h1', 'Armurerie')),
    h('div.toolbar', search),
    list,
  );
}

function recipePanel(recipe, stations) {
  /* Un composant est couvert dès qu'une station détient la quantité requise. */
  const missing = recipe.components.filter((c) =>
    !stations.some((s) => (c.stocks[s.code] ?? 0) >= c.quantity)).length;

  return panel(recipe.name, {
    count: recipe.components.length,
    flush: true,
    tools: missing
      ? h('span.tag.is-low', `${missing} composant${missing > 1 ? 's' : ''} à couvrir`)
      : h('span.tag.is-ok', 'Fabricable'),
  },
  h('table.table',
    h('thead', h('tr',
      h('th', 'Composant'),
      h('th', { class: 'num' }, 'Requis'),
      ...stations.map((s) => h('th', { class: 'num', title: s.name }, s.code)),
      h('th', 'Où en trouver'),
    )),
    h('tbody', recipe.components.map((c) => h('tr',
      h('td', c.name),
      h('td', { class: 'num' }, num(c.quantity)),
      ...stations.map((s) => {
        const qty = c.stocks[s.code] ?? 0;
        const tone = qty >= c.quantity ? 'ok' : (qty > 0 ? 'low' : 'empty');
        return h('td', { class: `num is-${tone}` }, num(qty));
      }),
      h('td', h('em.hint', c.vendorHint || 'Origine inconnue')),
    ))),
  ));
}

/* ============================================================== routes */

export async function routesView() {
  const routes = await get('/routes');

  if (!routes.length) {
    return h('div',
      h('div.head', h('span.eyebrow', 'Réseau'), h('h1', 'Routes commerciales')),
      empty('Aucune route déclarée',
        'Les routes disent d\'où provient chaque marchandise. Un officier peut les ajouter depuis la gestion.'),
    );
  }

  /* Regroupement par couple origine → destination, comme un plan de ligne. */
  const lanes = new Map();
  for (const r of routes) {
    const from = r.source_name || r.source_label || 'Origine externe';
    const key = `${from}\u0000${r.dest_name}`;
    if (!lanes.has(key)) lanes.set(key, { from, to: r.dest_name, code: r.dest_code, goods: [] });
    lanes.get(key).goods.push(r.item_name);
  }

  return h('div',
    h('div.head', h('span.eyebrow', 'Réseau'), h('h1', 'Routes commerciales')),
    h('div', [...lanes.values()].map((lane) =>
      panel(`${lane.from} → ${lane.to}`, { count: lane.goods.length },
        h('div.crew', lane.goods.map((g) => h('span.chip', g))),
      ))),
  );
}

/* ========================================================== classement */

export async function boardView(ctx) {
  const state = ctx.boardDays ||= 30;
  const rows = await get(`/leaderboard?days=${state}`);

  const table = h('div.board');
  if (!rows.length) {
    table.appendChild(empty('Rien à classer',
      'Le classement compte les points de mérite : quantité livrée multipliée par le ' +
      'volume de la marchandise, puis par la prime de risque de la mission.'));
  } else {
    rows.forEach((r, i) => table.appendChild(h('div.board__row',
      h('span.board__rank', String(i + 1).padStart(2, '0')),
      h('strong', r.callsign || r.display_name),
      h('span.board__runs', `${num(r.runs)} run${r.runs > 1 ? 's' : ''}`),
      h('span.board__units', { title: `${num(r.units)} unités transportées` },
        `${num(r.points)} pts`),
    )));
  }

  return h('div',
    h('div.head', h('span.eyebrow', 'Mérite'), h('h1', 'Classement des pilotes'),
      h('p.hint', { style: 'margin:.4rem 0 0' },
        'Points = quantité × volume unitaire × prime de risque. ' +
        'Le volume égalise l\'effort entre marchandises légères et encombrantes.')),
    h('div.toolbar', select(
      [{ value: 7, label: '7 jours' }, { value: 30, label: '30 jours' }, { value: 365, label: 'Année' }],
      { value: state, onChange: (e) => { ctx.boardDays = Number(e.target.value); ctx.reload(); } },
    )),
    table,
  );
}
