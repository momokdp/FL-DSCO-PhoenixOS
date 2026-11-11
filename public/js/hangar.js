/* =====================================================================
   Le hangar : l'espace où le pilote tient ses vaisseaux.

   Il n'y saisit aucune soute. Il choisit un modèle dans le catalogue
   relevé sur darkstat, lui donne un nom, et désigne celui qu'il vole le
   plus souvent. La console lit la soute sur le modèle : c'est elle qui
   borne ensuite ce qu'un voyage peut livrer.
   ===================================================================== */

import {
  h, get, post, put, del, num, toast, notifyError, modal, confirmDialog,
  field, input, empty, panel, clear,
} from './ui.js';
import { t } from './i18n.js';

// Les types que darkstat attribue aux vaisseaux. Ceux qui servent au
// transport viennent en tête de liste et sont seuls proposés d'office.
const TYPES_DE_FRET = ['transport', 'freighter'];

const aPlat = (texte) => String(texte ?? '')
  .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const typeLisible = (type) => {
  if (!type) return '—';
  const cle = `shiptype.${type}`;
  const rendu = t(cle);
  return rendu === cle ? type : rendu;
};

/**
 * Nombre d'unités d'une marchandise qu'une soute emporte. Même règle que
 * le serveur, marge d'arrondi comprise : l'écran ne doit pas proposer une
 * quantité que la livraison refusera.
 */
export function holdUnits(hold, volume) {
  const vol = Number(volume) > 0 ? Number(volume) : 1;
  const cale = Number(hold);
  if (!Number.isFinite(cale) || cale <= 0) return 0;
  return Math.floor(cale / vol + 1e-6);
}

/** Libellé d'un vaisseau dans une liste de choix : son nom et sa soute. */
export const shipLabel = (s) =>
  `${s.name} · ${num(s.hold)} ${t('common.unit')}`;

/* -------------------------------------------------- choix d'un modèle */

/**
 * Sélecteur de modèle : une recherche, un filtre, une liste.
 *
 * Le catalogue compte près de cinq cents vaisseaux, dont une majorité de
 * chasseurs et de vaisseaux de ligne qu'aucun convoyeur ne choisira. On ne
 * montre d'abord que les transports et les cargos ; une case ouvre le
 * reste. Plusieurs modèles portent le même nom : la soute et le type,
 * affichés sur chaque ligne, les départagent.
 */
function modelPicker(models) {
  const recherche = input({ type: 'search', placeholder: t('hangar.searchModel') });
  const tout = h('input', { type: 'checkbox' });
  const liste = h('select.input.hangar__models', { size: '9', name: 'model' });
  const compte = h('em.hint');

  const peindre = () => {
    const mots = aPlat(recherche.value).split(/\s+/).filter(Boolean);
    const garde = liste.value;
    const visibles = models.filter((m) =>
      (tout.checked || TYPES_DE_FRET.includes(m.type))
      && mots.every((w) => aPlat(m.name).includes(w)));

    clear(liste);
    for (const m of visibles) {
      liste.appendChild(h('option', { value: m.nickname, selected: m.nickname === garde },
        `${m.name} — ${num(m.hold)} ${t('common.unit')} · ${typeLisible(m.type)}`));
    }
    compte.textContent = t('hangar.modelCount', { v: visibles.length, n: models.length });
  };

  recherche.addEventListener('input', peindre);
  tout.addEventListener('change', peindre);
  peindre();

  return {
    node: h('div.hangar__picker',
      recherche,
      h('label.hangar__all', tout, h('span', t('hangar.allTypes'))),
      liste,
      compte,
    ),
    get value() { return liste.value || null; },
    get model() { return models.find((m) => m.nickname === liste.value) || null; },
  };
}

/* ------------------------------------------------------------ actions */

async function addFlow(models, relire) {
  const choix = modelPicker(models);
  const nom = input({ name: 'name', maxlength: '40', placeholder: t('hangar.namePlaceholder') });

  const result = await modal({
    title: t('hangar.addTitle'),
    width: '34rem',
    build: () => h('div',
      field(t('hangar.model'), choix.node),
      field(t('hangar.name'), nom, t('hangar.nameHint')),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('hangar.add'), variant: 'primary',
        onClick: (c) => {
          if (!choix.value) { toast(t('hangar.pickModel'), 'err'); return; }
          c({ model: choix.value, name: nom.value });
        } },
    ],
  });

  if (!result) return;
  try {
    await post('/me/ships', result);
    toast(t('hangar.added'));
    relire();
  } catch (e) { notifyError(e); }
}

async function renameFlow(ship, relire) {
  const nom = input({ name: 'name', maxlength: '40', value: ship.name });
  const result = await modal({
    title: t('hangar.renameTitle'),
    build: () => field(t('hangar.name'), nom),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('common.save'), variant: 'primary', onClick: (c) => c({ name: nom.value }) },
    ],
  });

  if (!result) return;
  try {
    await put(`/me/ships/${ship.id}`, result);
    relire();
  } catch (e) { notifyError(e); }
}

/**
 * Rattache à un modèle un vaisseau repris de l'ancienne déclaration : on
 * n'en connaissait que la cale saisie par le pilote.
 */
async function attachFlow(ship, models, relire) {
  const choix = modelPicker(models);
  const nom = input({ name: 'name', maxlength: '40', placeholder: t('hangar.namePlaceholder') });

  const result = await modal({
    title: t('hangar.attachTitle'),
    width: '34rem',
    build: () => h('div',
      h('p', { style: 'margin-top:0' }, t('hangar.attachBody', { v: num(ship.hold) })),
      field(t('hangar.model'), choix.node),
      field(t('hangar.name'), nom, t('hangar.nameHint')),
    ),
    actions: [
      { label: t('common.cancel'), value: null },
      { label: t('common.save'), variant: 'primary',
        onClick: (c) => {
          if (!choix.model) { toast(t('hangar.pickModel'), 'err'); return; }
          // Sans nom saisi, le vaisseau prend celui de son modèle plutôt
          // que de garder l'intitulé provisoire de la reprise.
          c({ model: choix.value, name: nom.value.trim() || choix.model.name });
        } },
    ],
  });

  if (!result) return;
  try {
    await put(`/me/ships/${ship.id}`, result);
    toast(t('hangar.attached'));
    relire();
  } catch (e) { notifyError(e); }
}

async function retireFlow(ship, relire) {
  if (!await confirmDialog(t('hangar.retireTitle'),
    t('hangar.retireBody', { name: ship.name }), t('hangar.retire'))) return;
  try {
    await del(`/me/ships/${ship.id}`);
    toast(t('hangar.retired'));
    relire();
  } catch (e) { notifyError(e); }
}

/* ---------------------------------------------------------------- vue */

export async function hangarView(ctx) {
  const [hangar, models] = await Promise.all([get('/me/ships'), get('/ships/models')]);
  const relire = () => ctx.reload();

  const activer = async (ship) => {
    try {
      await post(`/me/ships/${ship.id}/activate`);
      relire();
    } catch (e) { notifyError(e); }
  };

  const ligne = (s) => h('tr',
    h('td', h('strong', s.name),
      s.active ? h('span.tag.tag--bonus', { style: 'margin-left:.4rem' }, t('hangar.active')) : null),
    h('td', s.model
      ? [s.model.name, s.model.retiredFromGame ? h('em.hint', ` ${t('hangar.goneFromGame')}`) : null]
      : h('span.tag.tag--cancelled', t('hangar.toSpecify'))),
    h('td', s.model ? typeLisible(s.model.type) : '—'),
    h('td', { class: 'num' }, `${num(s.hold)} ${t('common.unit')}`,
      s.model ? null : h('em.hint', ` ${t('hangar.declared')}`)),
    h('td', { class: 'row-actions' },
      s.model
        ? null
        : h('button.btn.btn--primary.btn--sm', { type: 'button',
          onClick: () => attachFlow(s, models, relire) }, t('hangar.attach')),
      s.active
        ? null
        : h('button.btn.btn--steel.btn--sm', { type: 'button', onClick: () => activer(s) },
          t('hangar.activate')),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => renameFlow(s, relire) },
        t('hangar.rename')),
      h('button.btn.btn--ghost.btn--sm', { type: 'button', onClick: () => retireFlow(s, relire) },
        t('hangar.retire')),
    ),
  );

  const ajouter = h('button.btn.btn--primary.btn--sm', {
    type: 'button',
    disabled: !models.length,
    onClick: () => addFlow(models, relire),
  }, t('hangar.add'));

  const flotte = hangar.ships.length
    ? panel(t('hangar.fleet'), { count: hangar.ships.length, tools: ajouter, flush: true },
      h('table.table',
        h('thead', h('tr', ...[t('hangar.colName'), t('hangar.colModel'), t('hangar.colType'),
          t('hangar.colHold'), ''].map((x) => h('th', x)))),
        h('tbody', hangar.ships.map(ligne)),
      ))
    : panel(t('hangar.fleet'), { tools: ajouter },
      empty(t('hangar.empty'), t('hangar.emptyHint')));

  return h('div',
    h('div.head', h('span.eyebrow', t('hangar.eyebrow')), h('h1', t('hangar.title'))),
    h('p.hint', { style: 'margin:0 0 1rem;max-width:68ch' }, t('hangar.intro')),
    // Tant que darkstat n'a pas rendu son catalogue, il n'y a aucun modèle
    // à choisir : le dire évite de laisser un bouton grisé sans explication.
    models.length ? null : h('p.hint.loops__notice', t('hangar.noCatalog')),
    flotte,
  );
}
