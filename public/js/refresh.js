/* =====================================================================
   Rafraîchissement automatique de l'écran.

   Le serveur pousse déjà ce qu'il sait (flux d'événements), mais un flux
   coupé par un proxy, une passe d'analyse silencieuse ou une pastille de
   relevé figée laissent l'affichage en arrière. Un rappel périodique
   comble ces trous sans que le pilote ait à recharger la page.

   La cadence est programmée par le pilote depuis son espace perso et
   mémorisée d'une visite à l'autre, comme la langue.
   ===================================================================== */

const CLE = 'kadesh.refresh';

/** Cadences proposées, en secondes. 0 coupe le rafraîchissement. */
export const cadences = [0, 15, 30, 60, 120, 300];

/**
 * Une minute par défaut : assez pour qu'un pilote qui laisse la console
 * ouverte voie arriver les missions des autres, assez peu pour ne pas
 * interroger le serveur à vide pendant qu'il lit un tableau.
 */
const DEFAUT = 60;

let cadence = lire();
let minuteur = null;
let tache = null;
let enPause = false;

function lire() {
  try {
    // Un réglage absent n'est pas un zéro : sans ce contrôle, Number(null)
    // valait 0 et la console démarrait rafraîchissement coupé.
    const brut = localStorage.getItem(CLE);
    if (brut === null) return DEFAUT;
    const v = Number(brut);
    return cadences.includes(v) ? v : DEFAUT;
  } catch {
    return DEFAUT; // navigation privée : la cadence tient le temps de la visite
  }
}

export const refreshSeconds = () => cadence;

/** Change la cadence et réarme aussitôt : le choix doit se sentir tout de suite. */
export function setRefreshSeconds(valeur) {
  const n = Number(valeur);
  cadence = cadences.includes(n) ? n : DEFAUT;
  try { localStorage.setItem(CLE, String(cadence)); } catch { /* sans conséquence */ }
  armer();
  return cadence;
}

/**
 * `action` est appelée à chaque échéance. Jamais deux fois en parallèle :
 * le minuteur n'est réarmé qu'au retour de l'appel précédent.
 */
export function startAutoRefresh(action) {
  tache = action;

  // Un onglet en arrière-plan n'a personne à informer : on le laisse
  // tranquille et on rafraîchit dès qu'il revient au premier plan.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !enPause) return;
    enPause = false;
    passer();
  });

  armer();
}

function armer() {
  clearTimeout(minuteur);
  minuteur = null;
  enPause = false;
  if (!tache || cadence <= 0) return;
  if (document.hidden) { enPause = true; return; }
  minuteur = setTimeout(passer, cadence * 1000);
}

async function passer() {
  if (tache && cadence > 0 && !occupe()) {
    try {
      await tache();
    } catch { /* la vue signale elle-même ses erreurs ; le prochain passage retentera */ }
  }
  armer();
}

/**
 * Les cas où un rafraîchissement ferait plus de mal que de bien : une
 * fenêtre ouverte, qu'il effacerait, et une saisie en cours, dont il
 * reprendrait le champ sous les doigts du pilote.
 *
 * Un champ déjà rempli compte comme une saisie même sans curseur dedans :
 * un filtre de recherche posé sur un tableau serait effacé par le nouveau
 * rendu. Les listes déroulantes, elles, ne retiennent rien : les vues
 * relisent leur choix à chaque rendu, et les bloquer aurait suffi à geler
 * le rafraîchissement dès que le pilote a changé sa propre cadence.
 */
function occupe() {
  const modale = document.getElementById('modal');
  if (modale && modale.hidden === false) return true;

  const actif = document.activeElement;
  if (actif && /^(INPUT|TEXTAREA)$/.test(actif.tagName)) return true;

  const scene = document.getElementById('stage');
  for (const champ of scene ? scene.querySelectorAll('input, textarea') : []) {
    if (/^(button|submit|reset|checkbox|radio)$/.test(champ.type)) continue;
    if (champ.value !== '') return true;
  }
  return false;
}
