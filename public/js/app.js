/* =====================================================================
   Amorçage, routage par ancre et flux temps réel.
   ===================================================================== */

import { h, get, ago, clear, toast, loading, empty } from './ui.js';
import { t, lang, setLang, languages } from './i18n.js';
import { missionsView, mineView, stationsView, recipesView, routesView, loopsView, boardView } from './views.js';
import { adminView } from './admin.js';
import { startAutoRefresh } from './refresh.js';

const ROUTES = {
  missions: { view: missionsView, key: 'nav.missions' },
  mine: { view: mineView, key: 'nav.mine' },
  stations: { view: stationsView, key: 'nav.stations' },
  recipes: { view: recipesView, key: 'nav.recipes' },
  routes: { view: routesView, key: 'nav.routes' },
  loops: { view: loopsView, key: 'nav.loops' },
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
  startAutoRefresh(refreshAll);
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
  // Le serveur fournit déjà l'adresse complète de l'avatar : la recomposer
  // ici, avec l'identifiant interne du pilote, donnait une adresse fausse.
  const avatar = u.avatar || null;

  // La déconnexion change l'état de la session : c'est un POST. Un simple
  // lien partait en GET, que le serveur ne connaît pas — il rendait la
  // console, session intacte.
  const quitter = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      location.href = '/';
    }
  };

  clear(document.getElementById('whoami')).append(
    h('span.who__name', u.callsign || u.displayName || u.username),
    h('span.who__role', role),
    langSwitch(),
    h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: quitter }, t('nav.logout')),
  );
  if (avatar) document.querySelector('.who').style.setProperty('--avatar', `url("${avatar}")`);
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

/* ------------------------------------------------- rafraîchissement */

/**
 * Un passage du rafraîchissement automatique : la fraîcheur du relevé,
 * puis la vue affichée. Le rendu est silencieux — l'écran ne doit pas
 * clignoter sur un rafraîchissement que le pilote n'a pas demandé.
 */
async function refreshAll() {
  await refreshSync();
  await render(current(), { silent: true });
}

/**
 * Relit l'état de la dernière lecture darkstat. Sans cela, la pastille
 * d'en-tête vieillissait à l'écran sans jamais apprendre qu'un relevé
 * avait eu lieu : seul un F5 la remettait à l'heure.
 */
async function refreshSync() {
  try {
    const me = await get('/me');
    if (me?.sync) {
      ctx.sync = me.sync;
      paintSync();
    }
  } catch { /* le prochain passage retentera */ }
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

  // Une livraison émet coup sur coup « missions:changed » et
  // « stock:updated » : rechargée à chaque événement, la vue était relue
  // deux fois de suite par tous les pilotes connectés. Les événements d'une
  // même rafale ne valent qu'un rechargement.
  let rafale = null;
  const recharger = () => {
    clearTimeout(rafale);
    rafale = setTimeout(() => {
      rafale = null;
      if (document.getElementById('modal').hidden === false) return;
      ctx.reload();
    }, 250);
  };

  const touch = (routes) => () => {
    if (document.getElementById('modal').hidden === false) return;
    if (routes.includes(current())) recharger();
  };

  // Le classement suit les livraisons : une part de cagnotte annoncée à un
  // pilote change dès qu'un autre livre.
  source.addEventListener('missions:changed', touch(['missions', 'mine', 'admin', 'loops', 'board']));
  // Les circuits sont refaits par la passe horaire : l'écran doit suivre
  // sans que le pilote ait à le recharger.
  source.addEventListener('loops:changed', touch(['loops']));
  source.addEventListener('stations:changed', touch(['stations', 'admin']));
  source.addEventListener('routes:changed', touch(['routes']));

  // Le serveur annonce « stock:updated » — c'est le nom émis par le relevé
  // darkstat comme par les corrections d'officier. L'interface guettait
  // « stock:changed » et « sync:done », que personne n'émet : les écrans de
  // stock restaient en arrière jusqu'au F5 suivant.
  // Le relevé rapporte aussi les fonds des stations : la cagnotte, et donc le
  // revenu estimé de chaque pilote, bouge à chaque synchronisation.
  source.addEventListener('stock:updated', () => {
    refreshSync();
    touch(['stations', 'missions', 'recipes', 'admin', 'board'])();
  });

  // Un relevé en échec doit se voir dans l'en-tête sans attendre le suivant.
  source.addEventListener('sync:error', () => { refreshSync(); });

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
  const keys = { m: 'missions', e: 'mine', s: 'stations', a: 'recipes', r: 'routes', b: 'loops', c: 'board' };
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
