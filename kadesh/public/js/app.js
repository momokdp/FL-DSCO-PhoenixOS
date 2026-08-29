/* =====================================================================
   Amorçage, routage par ancre et flux temps réel.
   ===================================================================== */

import { h, get, ago, clear, toast, loading, empty } from './ui.js';
import { missionsView, mineView, stationsView, recipesView, routesView, boardView } from './views.js';
import { adminView } from './admin.js';

const ROUTES = {
  missions: { view: missionsView, title: 'Missions' },
  mine: { view: mineView, title: 'Mes runs' },
  stations: { view: stationsView, title: 'Soutes' },
  recipes: { view: recipesView, title: 'Armurerie' },
  routes: { view: routesView, title: 'Routes' },
  board: { view: boardView, title: 'Classement' },
  admin: { view: adminView, title: 'Gestion', role: 'officer' },
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
  } catch {
    return showGate('La console est injoignable. Vérifiez que le service tourne.');
  }

  if (!me.user) return showGate();

  ctx.user = me.user;
  ctx.sync = me.sync;

  document.getElementById('boot').hidden = true;
  document.getElementById('shell').hidden = false;

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
    h('h1', 'Console logistique Kadesh'),
    h('p', message || 'Identifiez-vous avec Discord pour consulter les soutes et prendre des missions.'),
    !message && h('a.btn.btn--primary', { href: '/auth/discord' }, 'Se connecter avec Discord'),
  ));
}

/* ---------------------------------------------------------- en-tête */

function paintIdentity() {
  const u = ctx.user;
  const role = u.role === 'admin' ? 'Administrateur' : u.role === 'officer' ? 'Officier' : 'Pilote';
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    : null;

  clear(document.getElementById('whoami')).append(
    h('span.who__name', u.callsign || u.displayName || u.username),
    h('span.who__role', role),
    h('a.btn.btn--ghost.btn--sm', { href: '/auth/logout' }, 'Quitter'),
  );
  if (avatar) document.querySelector('.who').style.setProperty('--avatar', `url(${avatar})`);
}

function paintSync() {
  const pill = document.getElementById('syncPill');
  const at = ctx.sync?.lastSyncAt || ctx.sync?.last?.finished_at;
  document.getElementById('syncAge').textContent = at ? `il y a ${ago(at)}` : 'jamais';
  const stale = !at || (Date.now() - Date.parse(String(at).replace(' ', 'T') + 'Z')) > 45 * 60_000;
  pill.classList.toggle('is-down', ctx.sync?.last?.status === 'error');
  pill.classList.toggle('is-stale', stale && ctx.sync?.last?.status !== 'error');
}

/* ------------------------------------------------------------- routage */

let token = 0;

async function render(route, { silent = false } = {}) {
  const entry = ROUTES[route] || ROUTES.missions;

  if (entry.role && RANK[ctx.user.role] < RANK[entry.role]) {
    stage().replaceChildren(empty('Accès réservé',
      'Cette section est réservée aux officiers. Demandez à un administrateur de vous y autoriser.'));
    return;
  }

  for (const link of document.querySelectorAll('#rail a')) {
    link.classList.toggle('is-active', link.dataset.nav === route);
  }
  document.title = `${entry.title} · Console Kadesh`;

  const mine = ++token;
  if (!silent) stage().replaceChildren(loading());

  try {
    const node = await entry.view(ctx);
    if (mine !== token) return; // une navigation plus récente a pris la main
    stage().replaceChildren(node);
    stage().scrollTop = 0;
  } catch (e) {
    if (mine !== token) return;
    stage().replaceChildren(empty('Chargement impossible', e.message,
      h('button.btn.btn--ghost', { type: 'button', onClick: () => render(route) }, 'Réessayer')));
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

boot();
