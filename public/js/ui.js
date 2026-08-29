/* =====================================================================
   Socle client : accès réseau, notifications, modale, fabrique de DOM.
   Aucun framework : les vues renvoient des noeuds, le routeur les pose.
   ===================================================================== */

/* ------------------------------------------------------------- réseau */

export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    location.href = '/auth/discord';
    throw new Error('Session expirée.');
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* réponse sans corps */ }

  if (!res.ok) {
    throw new Error(payload?.error || `Le serveur a répondu ${res.status}.`);
  }
  return payload;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

/* --------------------------------------------------------- fabrique DOM */

/**
 * h('div.classe', { attr: v }, ...enfants)
 * Les enfants acceptent chaînes, noeuds, tableaux, null.
 */
export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && props.constructor === Object) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  } else if (props != null) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

function append(parent, nodes) {
  for (const node of nodes) {
    if (node == null || node === false || node === '') continue;
    if (Array.isArray(node)) append(parent, node);
    else if (node instanceof Node) parent.appendChild(node);
    else parent.appendChild(document.createTextNode(String(node)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ------------------------------------------------------------- formats */

const NF = new Intl.NumberFormat('fr-FR');
export const num = (v) => NF.format(Math.round(Number(v) || 0));

export function signed(v) {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? `+${num(n)}` : num(n);
}

/** « il y a 4 min » — la fraîcheur du relevé compte plus que l'heure exacte. */
export function ago(iso) {
  if (!iso) return 'jamais';
  const then = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then)) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

export function dateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(+d) ? '—' : d.toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/* ------------------------------------------------ jauge de remplissage */

/**
 * Élément signature de la console.
 * La piste va de 0 au plafond de soute. Le repère marque le seuil bas ;
 * tout ce qui est à sa gauche est un déficit à combler.
 * La part « en attente » est ce qu'un pilote a livré mais que l'API n'a
 * pas encore confirmé : elle apparaît hachurée, jamais comme acquise.
 */
export function gauge({ qty, min = 0, max = 0, pending = 0 }) {
  const ceiling = Math.max(max, min * 1.5, qty, 1);
  const confirmed = Math.max(0, qty - pending);
  const pct = (v) => `${Math.min(100, Math.max(0, (v / ceiling) * 100))}%`;

  const level = min > 0 && qty <= 0 ? 'empty'
    : min > 0 && qty < min ? 'low'
      : max > 0 && qty >= max ? 'full' : 'ok';

  return h('div.gauge', { class: `is-${level}`, role: 'img',
    'aria-label': `${num(qty)} unités sur ${num(ceiling)}, seuil bas ${num(min)}` },
  h('span.gauge__fill', { style: `width:${pct(confirmed)}` }),
  pending > 0 && h('span.gauge__pending', {
    style: `left:${pct(confirmed)};width:${pct(pending)}`,
    title: `${num(pending)} en attente de confirmation par l'API`,
  }),
  min > 0 && h('span.gauge__min', { style: `left:${pct(min)}`, title: `Seuil bas : ${num(min)}` }),
  );
}

/* ------------------------------------------------------- notifications */

export function toast(message, kind = 'ok') {
  const host = document.getElementById('toasts');
  const el = h(`div.toast.toast--${kind === 'ok' ? 'ok' : 'err'}`, { text: message });
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, kind === 'ok' ? 3200 : 5200);
}

export const notifyError = (err) => toast(err?.message || String(err), 'err');

/* -------------------------------------------------------------- modale */

let closeModal = null;

/**
 * Ouvre une fenêtre. `build(close)` renvoie le corps ; les boutons du pied
 * sont décrits par `actions`. Résout avec la valeur passée à close().
 */
export function modal({ title, build, actions = [], width = null }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal');
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      host.hidden = true;
      clear(host);
      closeModal = null;
      resolve(value);
    };
    closeModal = close;

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);

    const foot = h('div.modal__foot',
      actions.map((a) => h(`button.btn${a.variant ? '.btn--' + a.variant : ''}`, {
        type: 'button',
        onClick: () => a.onClick ? a.onClick(close) : close(a.value ?? null),
      }, a.label)),
    );

    const box = h('div.modal__box', { style: width ? `max-width:${width}` : null, role: 'dialog', 'aria-modal': 'true' },
      h('div.modal__head',
        h('h2', title),
        h('button.modal__close', { type: 'button', 'aria-label': 'Fermer', onClick: () => close(null) }, '×'),
      ),
      h('div.modal__body', build(close)),
      actions.length ? foot : null,
    );

    clear(host);
    host.appendChild(h('div', { onClick: (e) => { if (e.target === e.currentTarget) close(null); },
      style: 'position:absolute;inset:0;display:grid;place-items:center;padding:1.5rem;overflow:auto' }, box));
    host.hidden = false;

    const first = box.querySelector('input,select,textarea,button.btn--primary');
    if (first) first.focus();
  });
}

export const dismissModal = (v) => closeModal && closeModal(v);

export function confirmDialog(title, message, confirmLabel = 'Confirmer') {
  return modal({
    title,
    build: () => h('p', { style: 'margin:0' }, message),
    actions: [
      { label: 'Annuler', value: false },
      { label: confirmLabel, variant: 'danger', value: true },
    ],
  });
}

/* -------------------------------------------------------- formulaires */

/** Décrit un champ ; `field()` produit le libellé et l'entrée associés. */
export function field(label, input, hint = null) {
  return h('label.field', h('span', label), input, hint && h('em.hint', hint));
}

export function input(props = {}) {
  return h('input.input', { type: 'text', ...props });
}

export function select(options, props = {}) {
  return h('select.input', props,
    options.map((o) => h('option', {
      value: o.value,
      selected: props.value != null && String(props.value) === String(o.value),
    }, o.label)),
  );
}

/** Lit un formulaire en objet, en convertissant les champs numériques. */
export function readForm(root) {
  const out = {};
  for (const el of root.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}

/* ------------------------------------------------------- états d'écran */

export const loading = (label = 'Lecture des relevés…') =>
  h('div.loading', label);

export function empty(title, detail = null, action = null) {
  return h('div.empty', h('strong', title), detail && h('p', detail), action);
}

export function panel(title, { count = null, tools = null, flush = false } = {}, ...body) {
  return h('section.panel',
    h('header.panel__head',
      h('h2', title),
      count != null && h('span.panel__count', num(count)),
      h('span.spacer'),
      tools,
    ),
    h(`div.panel__body${flush ? '.panel__body--flush' : ''}`, body),
  );
}
