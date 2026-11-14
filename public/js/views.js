/* =====================================================================
   Vues accessibles à tout pilote connecté.
   ===================================================================== */

import {
  h, get, post, num, signed, ago, dateShort, gauge, toast, notifyError,
  modal, confirmDialog, field, input, select, loading, empty, panel, clear, dec, put, pct,
} from './ui.js';
import { t, t2 } from './i18n.js';
import { cadences, refreshSeconds, setRefreshSeconds } from './refresh.js';
import { holdUnits, holdVolume, shipLabel } from './hangar.js';

const PRIORITES = ['critical', 'high', 'normal', 'low'];

/**
 * Met un texte à plat pour la recherche : sans casse ni accents, afin que
 * « helium » trouve « Hélium » et que le pilote tape sans y penser.
 */
const aPlat = (texte) => String(texte ?? '')
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/* ===================================================== tableau de missions */

export async function missionsView(ctx) {
  const state = ctx.filters ||= { station: '', direction: '' };
  state.search ??= '';

  // Un rechargement poussé par le serveur remplace toute la vue : si le
  // pilote était en train de taper sa recherche, on lui rend le curseur là
  // où il l'avait, sinon chaque livraison d'un autre couperait sa saisie.
  const ancien = document.activeElement;
  const enSaisie = ancien?.dataset?.role === 'mission-search';

  const [stations, missions] = await Promise.all([
    get('/stations'),
    get(`/missions?station=${state.station}&direction=${state.direction}`),
  ]);

  const body = h('div.missions');

  // Ce qu'il reste vraiment à couvrir, livraisons déduites. Le serveur le
  // calcule ; on garde le repli sur l'ancien calcul pour ne pas trier au
  // hasard si le champ manque.
  const reste = (m) => Math.max(0, m.remaining_qty ?? (m.target_qty - m.pledged_qty));

  // Dernière liste reçue du serveur : la recherche par marchandise la
  // filtre sur place, sans refaire d'appel à chaque lettre tapée.
  let recues = missions;

  const render = (toutes = recues) => {
    recues = toutes;
    clear(body);
    if (!toutes.length) {
      body.appendChild(empty(t('missions.empty'), t('missions.emptyHint')));
      return;
    }
    // Chaque mot tapé doit se retrouver dans le nom : « ore gold » trouve
    // « Gold Ore » sans imposer l'ordre des mots.
    const mots = aPlat(state.search).split(/\s+/).filter(Boolean);
    const list = mots.length
      ? toutes.filter((m) => { const nom = aPlat(m.item_name); return mots.every((w) => nom.includes(w)); })
      : toutes;
    if (!list.length) {
      body.appendChild(empty(t('missions.noMatch'),
        t('missions.noMatchHint', { q: state.search.trim() })));
      return;
    }
    // Le plus urgent d'abord : c'est ce qu'un pilote qui décolle veut voir.
    const tri = [...list].sort((a, b) =>
      PRIORITES.indexOf(a.priority) - PRIORITES.indexOf(b.priority) ||
      reste(b) - reste(a));

    // Une mission créée à la main répond à une décision d'officier — un
    // convoi à monter, une pénurie annoncée — que la génération automatique
    // ne sait pas deviner. Noyée dans les dizaines de missions de
    // réapprovisionnement, elle passait inaperçue : elle a donc son propre
    // bandeau, en tête de liste.
    const manuelles = tri.filter((m) => !m.auto);
    const autos = tri.filter((m) => m.auto);

    if (!manuelles.length) {
      body.appendChild(missionGrid(tri, ctx));
      return;
    }

    body.appendChild(missionBand('manual', t('missions.manualTitle'),
      t('missions.manualHint'), manuelles, ctx));
    if (autos.length) {
      body.appendChild(missionBand('auto', t('missions.autoTitle'), null, autos, ctx));
    }
  };

  const onFilter = async () => {
    body.replaceChildren(loading(t('common.loading')));
    try {
      render(await get(`/missions?station=${state.station}&direction=${state.direction}`));
    } catch (e) { notifyError(e); }
  };

  const search = input({
    type: 'search',
    placeholder: t('missions.search'),
    'aria-label': t('missions.search'),
    value: state.search,
    dataset: { role: 'mission-search' },
    onInput: (e) => { state.search = e.target.value; render(); },
  });

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
    search,
  );

  render(missions);

  if (enSaisie) {
    const debut = ancien.selectionStart;
    const fin = ancien.selectionEnd;
    // Le champ n'est posé à l'écran qu'après le retour de la vue : on attend
    // ce moment. Un minuteur plutôt qu'une image d'animation, que le
    // navigateur suspend dès que l'onglet passe à l'arrière-plan.
    setTimeout(() => {
      if (!search.isConnected) return;
      search.focus();
      try { search.setSelectionRange(debut, fin); } catch { /* sans conséquence */ }
    }, 0);
  }

  return h('div',
    h('div.head', h('span.eyebrow', t('missions.eyebrow')), h('h1', t('missions.title'))),
    toolbar,
    body,
  );
}

/** Grille de cartes, telle quelle. */
function missionGrid(list, ctx) {
  const grid = h('div.grid.grid--missions');
  for (const m of list) grid.appendChild(missionCard(m, ctx));
  return grid;
}

/**
 * Bandeau de missions : un titre, le nombre, puis les cartes.
 *
 * Même panneau que pour les routes, afin que la console n'ait qu'une façon
 * de séparer ce qui vient d'un officier de ce que la machine a calculé. Le
 * bandeau « manual » porte l'accent ambre ; celui des missions automatiques
 * reste neutre pour ne pas lui faire concurrence.
 */
function missionBand(kind, title, hint, list, ctx) {
  const bloc = panel(title, {
    count: list.length,
    tools: hint ? h('span.hint', hint) : null,
  }, missionGrid(list, ctx));
  bloc.dataset.kind = kind;
  return bloc;
}

/**
 * Carte de mission.
 *
 * Hiérarchie voulue : ce qu'il faut transporter, où, combien il reste, et
 * ce que ça rapporte. La criticité porte la couleur ; le bouton d'action
 * reste neutre pour ne pas concurrencer ce signal.
 */
function missionCard(m, ctx) {
  // Le restant vient du serveur : sur une mission créée à la main, il tient
  // compte de ce qui a déjà été livré, et pas seulement des engagements en
  // cours. Le recalculer ici ferait réapparaître l'objectif entier dès qu'un
  // pilote a livré sa part et quitté la liste des engagés.
  const restant = Math.max(0, m.remaining_qty ?? (m.target_qty - m.pledged_qty));
  const couvert = Math.max(0, m.target_qty - restant);
  const cible = m.direction === 'import' ? m.max_stock : m.min_stock;
  const avancement = m.target_qty > 0
    ? Math.min(100, Math.round((couvert / m.target_qty) * 100)) : 0;

  const volume = Number(m.item_volume) > 0 ? Number(m.item_volume) : 1;
  const primeMission = Number(m.reward_multiplier) > 0 ? Number(m.reward_multiplier) : 1;
  const primeItem = Number(m.risk_bonus) > 0 ? Number(m.risk_bonus) : 1;
  const prime = primeMission * primeItem;
  // Palier de prime : plus elle est forte, plus elle doit sauter aux yeux.
  const palier = prime >= 10 ? 'epic' : prime >= 3 ? 'high' : prime > 1 ? 'mid' : null;
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

  return h('article.mission', {
    dataset: { priority: m.priority, dir: m.direction, origin: m.auto ? 'auto' : 'manual' },
  },

    h('header.mission__bar',
      // Fl\u00e8che et libell\u00e9 dans une m\u00eame pastille pleine : le sens doit se
      // lire avant tout le reste, sans d\u00e9pendre de la seule teinte du bandeau.
      h('span.mission__flow',
        h('span.mission__arrow', m.direction === 'export' ? '\u2191' : '\u2193'),
        h('span.mission__way', t(`dir.${m.direction}Short`)),
      ),
      // La prime décide souvent du choix du pilote : elle doit se voir avant
      // même qu'il lise le reste de la carte.
      palier ? h('span.mission__bonus', {
        dataset: { tier: palier },
        title: t('mission.riskBonusHint', { v: dec(prime) }),
      }, t('mission.riskBonus', { v: dec(prime) })) : null,
      // Origine, criticité et avancement voyagent ensemble : si le bandeau
      // manque de place, le groupe passe à la ligne d'un bloc et reste calé
      // à droite, au lieu de semer une étiquette orpheline à gauche.
      h('span.mission__meta',
        // Seule l'exception s'étiquette : une mission automatique est le cas
        // courant, et son étiquette suffisait à replier le bandeau d'une
        // carte étroite dès qu'elle portait une prime.
        m.auto ? null : h('span.tag.tag--manual', t('mission.manual')),
        h('span.mission__prio', t(`priority.${m.priority}`)),
        couvert > 0 ? h('span.mission__pct', `${avancement}%`) : null,
      ),
    ),

    h('div.mission__body',
      h('div.mission__lead',
        h('h3.mission__item', m.item_name),
        h('p.mission__where',
          `${t(`dir.${m.direction}`)} `, h('b', m.station_name)),
        // L'autre bout du trajet : sans lui, le pilote ne sait pas où aller.
        legRoute(m),
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
      figure(t('mission.volume'), `\u00d7${dec(volume)}`, null, t('mission.perUnit')),
      // Le tonnage déjà livré se lit sous l'engagé : sans lui, une mission
      // entamée puis relâchée semblerait n'avoir jamais bougé.
      figure(t('mission.pledged'), num(m.pledged_qty), restant <= 0 ? 'ok' : null,
        m.delivered_qty > 0 ? t('mission.alreadyDelivered', { v: num(m.delivered_qty) }) : null),
    ),

    h('div.mission__reward',
      h('span.mission__rewardMain', t('mission.pointsFor', { v: num(m.target_qty * parUnite) })),
      h('span.mission__rewardRate', t('mission.rate', { v: dec(parUnite) })),
    ),

    m.claimants.length
      ? h('div.crew', m.claimants.map((c) => h('span.chip', { class: c.mine ? 'is-me' : null,
        title: `${num(c.pledged)} ${t('common.units')}` },
      c.name, c.pledged ? h('b', ` ${num(c.pledged)}`) : null)))
      : h('div.crew.crew__none', t('mission.nobody')),

    actions,
  );
}

/**
 * Deuxième point du trajet.
 *
 * Un import se charge quelque part avant d'être apporté ; un export doit
 * être emmené quelque part. Le libellé suit donc le sens de la mission.
 */
function legRoute(m) {
  const lieu = m.direction === 'export'
    ? (m.destination_hint || m.vendor_hint)
    : (m.origin_hint || m.vendor_hint);
  const label = m.direction === 'export' ? t('mission.sellAt') : t('mission.loadAt');

  return h('p.mission__leg', { class: lieu ? null : 'is-missing' },
    h('span.mission__legLabel', label),
    h('b', lieu || t('mission.noRoute')),
  );
}

const figure = (label, value, tone = null, sub = null) =>
  h('div.figure', { class: tone ? `is-${tone}` : null },
    h('span', label), h('b', value), sub ? h('i', sub) : null);

/* ------------------------------------------------------------- actions */

async function claimFlow(m, ctx) {
  const restant = Math.max(0, m.remaining_qty ?? (m.target_qty - m.pledged_qty));
  if (restant <= 0) { toast(t('mission.full'), 'err'); return; }

  // Un engagement vaut un voyage, fait avec un vaisseau du hangar : c'est
  // sa soute qui borne ce qu'on peut promettre, puis livrer.
  let hangar;
  try { hangar = await get('/me/ships'); } catch (e) { notifyError(e); return; }
  const vaisseaux = hangar.ships.filter((s) => s.usable);

  // Sans vaisseau utilisable, le serveur refuserait : autant le dire ici,
  // avec le chemin du hangar. Seule exception, le catalogue jamais relevé :
  // personne ne peut alors rattacher de vaisseau, et la mission se prend
  // comme avant.
  if (!vaisseaux.length && hangar.catalogReady) {
    const aller = await modal({
      title: t('claim.needShipTitle'),
      build: () => h('p', { style: 'margin:0' }, t('claim.needShipBody')),
      actions: [
        { label: t('common.cancel'), value: null },
        { label: t('claim.goToHangar'), variant: 'primary', value: true },
      ],
    });
    if (aller) location.hash = '#/hangar';
    return;
  }

  let vaisseau = vaisseaux.find((s) => s.active) || vaisseaux[0] || null;
  // Ce que le vaisseau emporte de CETTE marchandise : sa soute, divisée par
  // le volume qu'elle y occupe — réduit pour certaines classes de vaisseau.
  const contenanceDe = (s) => holdUnits(s.hold, holdVolume(m, s));
  const plafond = () => (vaisseau ? Math.min(restant, contenanceDe(vaisseau)) : restant);

  // Le champ part de 0, et non du besoin entier : pré-remplir la totalité
  // faisait réserver toute la mission au pilote qui validait sans lire, et
  // la bloquait pour les autres. C'est à lui de dire ce qu'il emporte.
  // Il reste plafonné à ce qui manque, et à ce que le vaisseau emporte.
  const champ = input({ type: 'number', name: 'pledged', min: '1', step: '1',
    max: String(plafond()), value: 0, class: 'input--num' });

  const contenance = h('em.hint');
  const peindreContenance = () => {
    if (!vaisseau) return;
    contenance.textContent = t('claim.capacity', { v: num(contenanceDe(vaisseau)) });
    champ.max = String(plafond());
  };
  peindreContenance();

  const choixVaisseau = vaisseau ? select(
    vaisseaux.map((s) => ({ value: s.id, label: shipLabel(s) })),
    { value: vaisseau.id,
      onChange: (e) => {
        vaisseau = vaisseaux.find((s) => String(s.id) === e.target.value) || vaisseau;
        peindreContenance();
      } },
  ) : null;

  const value = await modal({
    title: t('claim.title'),
    build: () => h('div',
      h('p', { style: 'margin-top:0' },
        `${t(`dir.${m.direction}Short`)} \u2014 `, h('strong', m.item_name), ` \u00b7 ${m.station_name}`),
      choixVaisseau ? h('label.field', h('span', t('claim.ship')), choixVaisseau, contenance) : null,
      field(t('claim.qtyLabel'), champ,
        `${t('mission.freeLeft', { v: num(restant) })} \u00b7 ${t('claim.qtyHint')}`),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('claim.confirm'), variant: 'primary',
        onClick: (c) => c(Math.min(plafond(), Math.max(0, Math.round(Number(champ.value) || 0)))) },
    ],
  });

  if (value == null) return;
  // Valider à 0 n'engage à rien. Le dire vaut mieux qu'inscrire le pilote
  // sur la mission pour une unité qu'il n'a pas choisie.
  if (value < 1) { toast(t('claim.qtyRequired'), 'err'); return; }

  try {
    await post(`/missions/${m.id}/claim`, { pledged: value, shipId: vaisseau?.id ?? null });
    toast(t('claim.done'));
    ctx.reload();
  } catch (e) { notifyError(e); }
}

async function deliverFlow(m, ctx) {
  const mien = m.claimants?.find((c) => c.mine);

  // Ce que le vaisseau engagé emporte de cette marchandise plafonne la
  // livraison. Le serveur le calcule, volume réduit de sa classe compris.
  // Il manque sur un engagement antérieur au hangar, qui se livre alors
  // sans plafond.
  const tenable = m.capacity ?? m.my_capacity ?? null;
  const propose = mien?.pledged || m.target_qty;

  const champ = input({ type: 'number', name: 'quantity', min: '0', step: '1',
    max: tenable != null ? String(tenable) : null,
    value: tenable != null ? Math.min(propose, tenable) : propose, class: 'input--num' });
  const note = input({ name: 'note', placeholder: t('common.optional') });

  const result = await modal({
    title: t('deliver.title'),
    build: () => h('div',
      h('p', { style: 'margin-top:0' }, h('strong', m.item_name), ` \u00b7 ${m.station_name}`),
      field(t('deliver.qtyLabel'), champ, tenable != null
        ? `${t('deliver.capacity', { v: num(tenable) })} ${t('deliver.qtyHint')}`
        : t('deliver.qtyHint')),
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
          t('mine.colShip'),
          t('mine.colPledged'), t('mine.colWorth'), t('mine.colSince'), ''].map((x) => h('th', x)))),
        h('tbody', claims.map((c) => h('tr',
          h('td', h('strong', c.item_name)),
          h('td', h(`span.way.way--${c.direction}`, t(`dir.${c.direction}Short`))),
          h('td', c.station_name),
          h('td', c.ship_name || '\u2014'),
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
    refreshControl(),
    enCours,
    passe,
  );
}

/**
 * Cadence de rafraîchissement, réglée par le pilote lui-même : c'est son
 * écran, et selon qu'il attend une livraison ou relit son historique, il
 * veut une console qui se tient à jour ou qui se tient tranquille.
 */
function refreshControl() {
  const libelle = (s) => (s === 0 ? t('refresh.off')
    : s < 60 ? t('refresh.seconds', { v: s })
      : s === 60 ? t('refresh.minute')
        : t('refresh.minutes', { v: s / 60 }));

  return h('div.toolbar',
    h('label.field.field--inline',
      h('span', t('refresh.label')),
      select(cadences.map((s) => ({ value: s, label: libelle(s) })), {
        value: refreshSeconds(),
        onChange: (e) => toast(t('refresh.saved', { v: libelle(setRefreshSeconds(e.target.value)) })),
      })),
    h('em.hint', t('refresh.hint')),
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

/* ============================================================== routes */

export async function routesView() {
  const routes = await get('/routes');
  if (!routes.length) {
    return h('div',
      h('div.head', h('span.eyebrow', t('routes.eyebrow')), h('h1', t('routes.title'))),
      empty(t('routes.empty'), t('routes.emptyHint')),
    );
  }

  const auto = routes.filter((r) => r.auto);
  const manuelles = routes.filter((r) => !r.auto);
  const releve = auto.find((r) => r.computed_at)?.computed_at;

  return h('div',
    h('div.head', h('span.eyebrow', t('routes.eyebrow')), h('h1', t('routes.title'))),

    manuelles.length ? panel(t('routes.manualTitle'), { count: manuelles.length },
      h('div', groupesManuels(manuelles))) : null,

    auto.length ? panel(t('routes.autoTitle'), {
      count: auto.length, flush: true,
      tools: releve ? h('span.hint', t('routes.scanned', { v: ago(releve) })) : null,
    },
    h('p.hint', { style: 'padding:.75rem 1rem 0;margin:0' }, t('routes.caveat')),
    h('table.table',
      h('thead', h('tr', ...['', t('recipes.colComponent'), t('mine.colStation'),
        t('routes.buyAt'), t('routes.colSystem'), t('common.currency')].map((x, i) =>
        h('th', { class: i === 5 ? 'num' : null }, x)))),
      h('tbody', auto.map((r) => h('tr',
        h('td', h('span.mission__arrow', { class: `is-${r.direction}` },
          r.direction === 'export' ? '\u2191' : '\u2193')),
        h('td', h('strong', r.item_name)),
        h('td', r.dest_name),
        h('td', h('b.route__base', r.source_label),
          r.faction_name ? h('em.hint', r.faction_name) : null),
        h('td', r.system_name || '\u2014',
          r.sector_coord ? h('em.hint', r.sector_coord) : null),
        h('td', { class: 'num' }, r.price != null ? num(r.price) : '\u2014'),
      ))),
    )) : null,
  );
}

/** Routes saisies : regroupées par couple origine-destination. */
function groupesManuels(routes) {
  const lanes = new Map();
  for (const r of routes) {
    const from = r.source_name || r.source_label || t('routes.external');
    const key = `${from}\u0000${r.dest_name}`;
    if (!lanes.has(key)) lanes.set(key, { from, to: r.dest_name, goods: [] });
    lanes.get(key).goods.push(r.item_name);
  }
  return [...lanes.values()].map((lane) => h('div', { style: 'margin-bottom:.9rem' },
    h('p.mission__leg', h('span.mission__legLabel', `${lane.from} \u2192 ${lane.to}`)),
    h('div.crew', lane.goods.map((g) => h('span.chip', g))),
  ));
}

/* ==================================================== boucles de trade */

/**
 * Circuits proposés au pilote.
 *
 * Un aller simple laisse rentrer à vide. Une boucle enchaîne deux missions
 * ouvertes sur la même station — une d'apport, une d'enlèvement — et
 * ramène le pilote à son point de départ.
 *
 * Les circuits sont calculés à l'heure par le serveur ; cet écran ne fait
 * que les mettre à l'échelle du vaisseau déclaré. Changer de cale ne
 * relance donc aucun calcul de marché, seulement une lecture.
 */
export async function loopsView(ctx) {
  const state = ctx.loopFilters ||= { station: '', shipId: null, cargo: '', ship: 'transport' };

  const hangar = await get('/me/ships');

  // `shipId` vaut l'identifiant d'un vaisseau du hangar, ou '' pour une
  // simulation libre. Au premier passage — ou si le vaisseau retenu a
  // quitté le hangar depuis — on part du vaisseau actif.
  const duHangar = () => hangar.ships.find((s) => String(s.id) === String(state.shipId)) || null;
  if (state.shipId !== '' && !duHangar()) {
    state.shipId = hangar.activeShipId ?? hangar.ships[0]?.id ?? '';
  }

  const requete = () => {
    const p = new URLSearchParams();
    if (state.station) p.set('station', state.station);
    const vaisseau = duHangar();
    if (vaisseau) {
      // L'identifiant suffit au serveur, qui lit soute, allure et classe
      // sur le modèle ; cale et allure l'accompagnent par compatibilité.
      p.set('shipId', vaisseau.id);
      p.set('cargo', vaisseau.hold);
      p.set('ship', vaisseau.shipClass);
    } else {
      if (state.cargo) p.set('cargo', state.cargo);
      if (state.ship) p.set('ship', state.ship);
    }
    return `/loops?${p}`;
  };

  const [stations, data] = await Promise.all([get('/stations'), get(requete())]);

  const corps = h('div.loops');

  // Ces deux lignes changent à chaque relecture : la cale retenue et
  // l'ancienneté du calcul. Les construire une fois puis les mettre à jour
  // évite le piège d'un avis figé au premier rendu — il annonçait encore
  // une cale de référence après que le pilote eut saisi la sienne.
  const avis = h('p.hint.loops__notice', { hidden: true });
  const releve = h('span.hint');

  const peindre = (d) => {
    avis.textContent = t('loops.defaultCargo', { v: num(d.cargo) });
    avis.hidden = !d.usingDefaultCargo;
    releve.textContent = d.computedAt ? t('loops.computed', { v: ago(d.computedAt) }) : '';

    clear(corps);
    if (!d.loops.length) {
      corps.appendChild(empty(t('loops.empty'), t('loops.emptyHint')));
      return;
    }
    for (const b of d.loops) corps.appendChild(loopCard(b, ctx));
  };

  const relire = async () => {
    corps.replaceChildren(loading(t('common.loading')));
    try { peindre(await get(requete())); } catch (e) { notifyError(e); }
  };

  const caleInput = input({
    type: 'number', min: '1', step: '100', class: 'input--num',
    value: state.cargo ?? '',
    placeholder: String(data.cargo),
    onChange: (e) => { state.cargo = e.target.value; relire(); },
  });

  const classeSelect = select(
    ['transport', 'freighter', 'frigate'].map((v) => ({ value: v, label: t(`ship.${v}`) })),
    { value: state.ship, onChange: (e) => { state.ship = e.target.value; relire(); } },
  );

  // Les circuits se lisent à l'échelle d'un vaisseau du hangar. La cale et
  // l'allure saisies à la main ne servent plus qu'à simuler un vaisseau
  // qu'on n'a pas : leurs champs n'apparaissent que pour cela.
  const simulation = h('span.toolbar__group', { style: 'display:contents' },
    h('label.field.field--inline', h('span', t('loops.cargo')), caleInput),
    h('label.field.field--inline', h('span', t('loops.shipClass')), classeSelect),
  );
  const montrerSimulation = () => {
    for (const el of simulation.children) el.hidden = !!duHangar();
  };
  montrerSimulation();

  const vaisseauSelect = select(
    [...hangar.ships.map((s) => ({ value: s.id, label: shipLabel(s) })),
      { value: '', label: t('loops.simulate') }],
    { value: state.shipId ?? '',
      onChange: (e) => { state.shipId = e.target.value; montrerSimulation(); relire(); } },
  );

  peindre(data);

  return h('div',
    h('div.head', h('span.eyebrow', t('loops.eyebrow')), h('h1', t('loops.title'))),

    h('div.toolbar',
      select(
        [{ value: '', label: t('loops.allStations') },
          ...stations.map((st) => ({ value: st.id, label: st.name }))],
        { value: state.station, onChange: (e) => { state.station = e.target.value; relire(); } },
      ),
      h('label.field.field--inline', h('span', t('loops.ship')), vaisseauSelect),
      simulation,
      h('span.spacer'),
      releve,
    ),

    // Tant que le pilote n'a rien déclaré, les chiffres reposent sur une
    // cale de référence : le dire vaut mieux que laisser croire le contraire.
    avis,

    h('p.hint', { style: 'margin:0 0 1rem;max-width:68ch' }, t('loops.caveat')),
    corps,
  );
}

/** Durée lisible : au-delà de l'heure, les minutes seules ne parlent plus. */
function duree(secondes) {
  const m = Math.max(1, Math.round(Number(secondes) / 60));
  if (m < 60) return t('common.durationM', { m });
  return t('common.durationH', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
}

/** Un lieu et ses attaches : faction, système, secteur. */
function lieu(bout) {
  const detail = [bout.faction, bout.system, bout.sector].filter(Boolean).join(' · ');
  return h('span.loop__place',
    h('b', bout.baseName),
    detail ? h('em.hint', detail) : null,
  );
}

function loopCard(b, ctx) {
  // Le vaisseau engagé est celui sur lequel le circuit est affiché. En
  // simulation, aucun n'est désigné : le serveur prend le vaisseau actif,
  // et refuse si la quantité simulée dépasse sa soute.
  const engager = async (missionId, qty) => {
    if (!(qty > 0)) return;
    try {
      await post(`/missions/${missionId}/claim`,
        { pledged: qty, shipId: ctx.loopFilters?.shipId || null });
      toast(t('claim.done'));
      ctx.reload();
    } catch (e) { notifyError(e); }
  };

  // `secondes` à null : le segment ne se parcourt pas. C'est le cas du
  // retour quand la boucle se referme sur sa propre base de départ —
  // afficher une minute le ferait passer pour un trajet.
  const segment = (rang, label, but, cargaison, argent, secondes) =>
    h('li.loop__leg',
      h('span.loop__rank', rang),
      h('div.loop__to', h('span.loop__label', label), but),
      h('div.loop__cargo', cargaison, argent ? h('em.hint', argent) : null),
      h('span.loop__legTime', secondes == null ? '—' : duree(secondes)),
    );

  const charge = (bout) =>
    h('span', h('b', num(bout.qty)), ` ${t('common.unit')} `, bout.itemName);

  return h('article.loop',
    h('header.loop__bar',
      h('strong.loop__rate', t('loops.perHour', { v: num(b.pointsPerHour) })),
      h('span.loop__points', `${num(b.points)} ${t('common.points')}`),
      h('span.spacer'),
      b.closesOnItself ? h('span.tag.tag--auto', t('loops.closesLoop')) : null,
      h('span.loop__time', { title: t('loops.roundTrip') }, duree(b.totalSeconds)),
    ),

    h('ol.loop__legs',
      // 1 — charger chez le fournisseur, livrer à la station.
      segment('1', t('loops.legLoad'), lieu(b.inbound), charge(b.inbound),
        b.inbound.cost != null ? t('loops.spend', { v: num(b.inbound.cost) }) : null,
        b.inbound.seconds),

      // 2 — la station : on dépose l'apport, on charge l'enlèvement.
      segment('2', t('loops.legDeliver'),
        h('span.loop__place', h('b', b.station.name), h('em.hint', b.station.code)),
        charge(b.outbound), null, b.outbound.seconds),

      // 3 — revendre, puis boucler sur le point de départ.
      // L'étiquette de l'en-tête dit déjà que la boucle se referme : le
      // répéter ici ne ferait qu'occuper la colonne du chargement.
      segment('3', t('loops.legSell'), lieu(b.outbound),
        b.closesOnItself
          ? null
          : h('span.hint', `${t('loops.legReturn')} ${b.inbound.baseName}`),
        b.outbound.revenue != null ? t('loops.earn', { v: num(b.outbound.revenue) }) : null,
        b.closesOnItself ? null : b.returnSeconds),
    ),

    h('div.mission__actions',
      h('button.btn.btn--steel.btn--sm', {
        type: 'button',
        onClick: () => engager(b.inbound.missionId, b.inbound.qty),
      }, `${t('loops.takeInbound')} · ${t('loops.forHold', { v: num(b.inbound.qty) })}`),
      h('button.btn.btn--steel.btn--sm', {
        type: 'button',
        onClick: () => engager(b.outbound.missionId, b.outbound.qty),
      }, `${t('loops.takeOutbound')} · ${t('loops.forHold', { v: num(b.outbound.qty) })}`),
    ),
  );
}

/* ========================================================== classement */

/**
 * Teintes du camembert.
 *
 * Huit couleurs distinctes, tirées de la palette de la console. Au-delà,
 * les pilotes partagent le gris : un neuvième ton inventé ne se
 * distinguerait plus du huitième, et la part concernée est de toute façon
 * marginale.
 */
const TEINTES = ['#E8A33D', '#4EC9D9', '#6FBF73', '#D9553F', '#A98BD1', '#E3C86A', '#5A8FD6', '#C97BA0'];
const teinte = (i) => TEINTES[i] || '#4E5C6B';

export async function boardView(ctx) {
  const periode = ctx.boardPeriod ||= 'month';
  const { rows, funds, pool, payoutShare, totalPoints } = await get(`/leaderboard?period=${periode}`);

  // Sans fonds de référence, il n'y a pas de cagnotte : on affiche les
  // pourcentages, qui eux sont exacts, et rien qui ressemble à une somme.
  const repartit = funds.hasBaseline && pool > 0;

  const table = h('div.board');
  if (!rows.length) {
    table.appendChild(empty(t('board.empty'), t('board.emptyHint')));
  } else {
    const tete = rows[0].points || 1;
    rows.forEach((r, i) => table.appendChild(h('div.board__row', { class: i < 3 ? 'is-podium' : null },
      h('span.board__rank', String(i + 1).padStart(2, '0')),
      h('span.board__dot', { style: `background:${teinte(i)}` }),
      h('strong.board__name', r.callsign || r.display_name),
      // Barre proportionnelle au meneur : le classement se lit sans comparer
      // mentalement des nombres à cinq chiffres.
      h('span.board__bar', h('i', { style: `width:${Math.round((r.points / tete) * 100)}%;background:${teinte(i)}` })),
      h('span.board__runs', t2('board.runs', r.runs)),
      h('span.board__units', { title: t('board.unitsHauled', { v: num(r.units) }) },
        `${num(r.points)} ${t('common.points')}`),
      h('span.board__share', pct(r.share)),
      h('span.board__payout', { title: repartit ? t('board.payoutTitle') : null },
        repartit ? `${num(r.payout)} cr` : '—'),
    )));
  }

  return h('div',
    h('div.head', h('span.eyebrow', t('board.eyebrow')), h('h1', t('board.title'))),

    // La cagnotte d'abord : c'est elle qui donne son sens au classement.
    fundsBanner(funds, { pool, payoutShare, ctx }),

    h('div.toolbar', h('div.tabs',
      ...[['month', t('board.month')], ['last', t('board.lastMonth')], ['year', t('board.year')]]
        .map(([value, label]) => h('button.chip', {
          type: 'button',
          class: periode === value ? 'is-on' : null,
          onClick: () => { ctx.boardPeriod = value; ctx.reload(); },
        }, label))),
    ),

    h('p.hint', { style: 'margin:0 0 1rem;max-width:70ch' },
      t('board.explain'), ' ', t('board.shareExplain')),

    h('section.payout',
      camembert(rows, { pool, repartit, totalPoints }),
      table,
    ),
  );
}

/**
 * Cagnotte du mois.
 *
 * L'API ne donne que le solde courant des stations : la variation se mesure
 * contre le premier relevé du mois. Tant qu'il n'existe pas, on affiche le
 * total sans prétendre connaître le gain.
 */
function fundsBanner(funds, { pool, payoutShare, ctx }) {
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
      funds.hasBaseline && h('span.hint',
        `${t('board.pool')} : `,
        h('b.pot__pool', `${num(pool)} cr`)),
      shareControl(payoutShare, ctx),
      h('span.hint', t('board.payoutNote')),
    ),
    h('div.pot__stations', funds.stations.map((s) =>
      h('span.chip', { title: s.name }, s.code, h('b', ` ${num(s.money)}`)))),
  );
}

/**
 * Part reversée aux pilotes.
 *
 * Réglable depuis le classement, et par un officier seulement : c'est ici
 * qu'on lit son effet, en crédits, sur chaque ligne. Un pilote voit la
 * valeur sans pouvoir y toucher — elle explique le montant qu'on lui
 * annonce.
 */
function shareControl(payoutShare, ctx) {
  if (!estOfficier(ctx)) {
    return h('span.hint', `${t('board.shareLabel')} : ${dec(payoutShare)} %`);
  }

  const champ = input({
    type: 'number', name: 'value', min: 0, max: 100, step: 1,
    value: payoutShare, class: 'input--num input--tiny',
    'aria-label': t('board.shareLabel'),
  });

  return h('form.pot__share', {
    onSubmit: async (e) => {
      e.preventDefault();
      try {
        await put('/admin/payout-share', { value: Number(champ.value) });
        toast(t('board.shareSaved'));
        ctx.reload();
      } catch (err) {
        notifyError(err);
      }
    },
  },
  h('span.hint', t('board.shareLabel')),
  champ,
  h('span.hint', '%'),
  h('button.btn.btn--ghost.btn--sm', { type: 'submit' }, t('common.save')),
  );
}

const estOfficier = (ctx) => ctx.user?.role === 'officer' || ctx.user?.role === 'admin';

/**
 * Camembert de participation.
 *
 * Le tableau dit qui mène ; le camembert dit dans quelles proportions, ce
 * qu'une colonne de pourcentages ne montre pas d'un coup d'oeil. C'est la
 * figure sur laquelle se décide la répartition, donc elle porte au centre
 * la somme à partager.
 *
 * Dessiné à la main plutôt qu'avec une bibliothèque : un arc de camembert
 * est un cercle en pointillé dont on règle le tiret et le décalage, et la
 * console n'a aucune étape de compilation à offrir à un paquet npm.
 */
function camembert(rows, { pool, repartit, totalPoints }) {
  const R = 62, EPAISSEUR = 24, TOUR = 2 * Math.PI * R;
  const parts = rows.filter((r) => r.share > 0);
  if (!parts.length) return null;

  let debut = 0;
  const arcs = parts.map((r, i) => {
    // Un cheveu de vide entre deux parts : sans lui, deux teintes voisines
    // se touchent et la frontière disparaît.
    const brut = TOUR * r.share;
    const trait = Math.max(0, brut - (parts.length > 1 ? 1.5 : 0));
    const arc = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${teinte(i)}"
        stroke-width="${EPAISSEUR}"
        stroke-dasharray="${trait.toFixed(2)} ${(TOUR - trait).toFixed(2)}"
        stroke-dashoffset="${(-debut).toFixed(2)}"><title>${
  echappe(`${r.callsign || r.display_name} — ${pct(r.share)}`)}</title></circle>`;
    debut += brut;
    return arc;
  }).join('');

  const svg = `<svg viewBox="0 0 160 160" class="pie" role="img"
      aria-label="${echappe(t('board.pieAlt'))}">
    <g transform="rotate(-90 80 80)">
      <circle cx="80" cy="80" r="${R}" fill="none"
              stroke="rgba(255,255,255,.05)" stroke-width="${EPAISSEUR}"/>
      ${arcs}
    </g>
  </svg>`;

  return h('div.pie__wrap', { html: svg },
    h('div.pie__hub',
      h('strong.pie__sum', repartit ? num(pool) : num(totalPoints)),
      h('span.pie__unit', repartit ? 'cr' : t('common.points')),
      h('span.pie__label', repartit ? t('board.pool') : t('board.pieShares')),
    ),
  );
}

/** Le camembert est posé en HTML brut : un indicatif de pilote y passe. */
const echappe = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
