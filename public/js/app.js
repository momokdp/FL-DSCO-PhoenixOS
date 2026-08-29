/* =====================================================================
   Amorçage, routage par ancre et flux temps réel.
   ===================================================================== */

import { h, get, ago, clear, toast, loading, empty } from './ui.js';
import { t, lang, setLang, languages } from './i18n.js';
import { missionsView, mineView, stationsView, recipesView, routesView, boardView } from './views.js';
import { adminView } from './admin.js';

const ROUTES = {
  missions: { view: missionsView, key: 'nav.missions' },
  mine: { view: mineView, key: 'nav.mine' },
  stations: { view: stationsView, key: 'nav.stations' },
  recipes: { view: recipesView, key: 'nav.recipes' },
  routes: { view: routesView, key: 'nav.routes' },
  board: { view: boardView, key: 'nav.board' },
  admin: { view: adminView, key: 'nav.admin', role: 'officer' },
};

const RANK = { member: 0, officer: 1, admin: 2 };

const ctx = {
  user: null,
  sync: null,
  reload: () => render(current(), { silent: true }),
};

const stage = () => document.getElementById('stage');
const current = () => (location.hash.replace(/^#\/?/, '') || 'missions').split('?')[0];

/* ------------------------------------------------------------- amorçage */

async function boot() {
  let me;
  try {
    me = await get('/me');
  } catch (err) {
    return showGate(`La console est injoignable. ${err.message}`);
  }

  if (!me || !me.user) return showGate();

  ctx.user = me.user;
  ctx.sync = me.sync;

  document.getElementById('boot').hidden = true;
  document.getElementById('shell').hidden = false;

  paintNav();
  paintIdentity();
  paintSync();
  setInterval(paintSync, 30_000);

  if (RANK[ctx.user.role] >= RANK.officer) document.getElementById('navAdmin').hidden = false;

  window.addEventListener('hashchange', () => render(current()));
  connectStream();
  render(current());
}

/** Écran de connexion : la seule page visible sans session. */
function showGate(message = null) {
  document.getElementById('boot').hidden = true;
  const shell = document.getElementById('shell');
  shell.hidden = false;
  shell.className = 'gate';
  clear(shell).appendChild(h('div.gate__box',
    h('div.gate__mark', 'KDS'),
    h('h1', t('gate.title')),
    h('p', message || t('gate.blurb')),
    !message && h('a.btn.btn--primary', { href: '/auth/discord' }, t('gate.button')),
    h('div.gate__langs', langSwitch()),
  ));
}

/* ---------------------------------------------------------- en-tête */

/** Bascule de langue : deux boutons, choix mémorisé. */
function langSwitch() {
  return h('div.langs', languages.map((code) =>
    h('button.chip', {
      type: 'button',
      class: code === lang ? 'is-on' : null,
      onClick: () => { setLang(code); location.reload(); },
    }, code.toUpperCase())));
}

/** Les libellés de navigation sont posés par le code, pas figés en HTML. */
function paintNav() {
  for (const link of document.querySelectorAll('#rail a[data-nav]')) {
    const entry = ROUTES[link.dataset.nav];
    const label = link.querySelector('.rail__label');
    if (entry && label) label.textContent = t(entry.key);
  }
  const brand = document.querySelector('.brand__name');
  if (brand) brand.textContent = t('app.title');
  const sync = document.querySelector('.sync__label');
  if (sync) sync.textContent = t('sync.label');
}

function paintIdentity() {
  const u = ctx.user;
  const role = t(`role.${u.role}`);
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    : null;

  clear(document.getElementById('whoami')).append(
    h('span.who__name', u.callsign || u.displayName || u.username),
    h('span.who__role', role),
    langSwitch(),
    h('a.btn.btn--ghost.btn--sm', { href: '/auth/logout' }, t('nav.logout')),
  );
  if (avatar) document.querySelector('.who').style.setProperty('--avatar', `url(${avatar})`);
}

function paintSync() {
  const pill = document.getElementById('syncPill');
  const at = ctx.sync?.lastSyncAt || ctx.sync?.last?.finished_at;
  document.getElementById('syncAge').textContent =
    at ? t('common.ago', { v: ago(at) }) : t('sync.never');
  const stale = !at || (Date.now() - Date.parse(String(at).replace(' ', 'T') + 'Z')) > 45 * 60_000;
  pill.classList.toggle('is-down', ctx.sync?.last?.status === 'error');
  pill.classList.toggle('is-stale', stale && ctx.sync?.last?.status !== 'error');
}

/* ------------------------------------------------------------- routage */

let token = 0;

async function render(route, { silent = false } = {}) {
  const entry = ROUTES[route] || ROUTES.missions;

  if (entry.role && RANK[ctx.user.role] < RANK[entry.role]) {
    stage().replaceChildren(empty(t('denied.title'), t('denied.body')));
    return;
  }

  for (const link of document.querySelectorAll('#rail a')) {
    link.classList.toggle('is-active', link.dataset.nav === route);
  }
  document.title = `${t(entry.key)} \u00b7 ${t('app.title')}`;

  const mine = ++token;
  if (!silent) stage().replaceChildren(loading(t('common.loading')));

  try {
    const node = await entry.view(ctx);
    if (mine !== token) return; // une navigation plus récente a pris la main
    stage().replaceChildren(node);
    stage().scrollTop = 0;
  } catch (e) {
    if (mine !== token) return;
    stage().replaceChildren(empty(t('common.failed'), e.message,
      h('button.btn.btn--ghost', { type: 'button', onClick: () => render(route) }, t('common.retry'))));
  }

  refreshBadge();
}

async function refreshBadge() {
  try {
    const mine = await get('/missions/mine');
    const badge = document.getElementById('mineBadge');
    badge.textContent = mine.length;
    badge.hidden = mine.length === 0;
  } catch { /* sans conséquence */ }
}

/* --------------------------------------------------------- temps réel */

/**
 * Le serveur pousse les changements. On ne recharge que si la vue
 * affichée est concernée, pour ne pas interrompre une saisie en cours.
 */
function connectStream() {
  const source = new EventSource('/api/events');

  const touch = (routes) => () => {
    if (document.getElementById('modal').hidden === false) return;
    if (routes.includes(current())) ctx.reload();
  };

  source.addEventListener('missions:changed', touch(['missions', 'mine', 'admin']));
  source.addEventListener('stations:changed', touch(['stations', 'admin']));
  source.addEventListener('stock:changed', touch(['stations', 'missions', 'recipes']));

  source.addEventListener('sync:done', (e) => {
    try { ctx.sync = { ...ctx.sync, lastSyncAt: JSON.parse(e.data).at }; } catch { /* ignore */ }
    paintSync();
    if (['stations', 'missions', 'recipes', 'admin'].includes(current())) ctx.reload();
  });

  source.onerror = () => {
    /* EventSource se reconnecte seul ; on signale seulement une coupure durable. */
    if (source.readyState === EventSource.CLOSED) {
      setTimeout(connectStream, 5000);
    }
  };
}

/* -------------------------------------------------------- raccourcis */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const keys = { m: 'missions', e: 'mine', s: 'stations', a: 'recipes', r: 'routes', c: 'board' };
  const target = keys[e.key.toLowerCase()];
  if (target) location.hash = `#/${target}`;
});

/**
 * Toute panne d'amorçage doit s'afficher. Un écran figé sans message est
 * indiagnosticable pour l'utilisateur comme pour l'administrateur.
 */
boot().catch((err) => {
  console.error('[amorçage]', err);
  showGate(`Erreur au démarrage : ${err.message}`);
});

window.addEventListener('error', (e) => {
  if (!document.getElementById('boot').hidden) {
    showGate(`Erreur de chargement : ${e.message}`);
  }
});
