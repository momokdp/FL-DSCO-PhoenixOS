/* =====================================================================
   Traductions.

   L'anglais est la langue par défaut : l'escadrille est internationale et
   la console doit être compréhensible sans explication. Le français reste
   disponible, et le choix est mémorisé d'une visite à l'autre.
   ===================================================================== */

const DICT = {
  en: {
    /* -------------------------------------------------------- charpente */
    'app.title': 'Kadesh Logistics',
    'nav.missions': 'Missions',
    'nav.mine': 'My runs',
    'nav.stations': 'Holds',
    'nav.recipes': 'Armory',
    'nav.routes': 'Routes',
    'nav.loops': 'Loops',
    'nav.board': 'Standings',
    'nav.admin': 'Manage',
    'nav.logout': 'Sign out',

    'role.member': 'Pilot',
    'role.officer': 'Officer',
    'role.admin': 'Administrator',

    'gate.title': 'Kadesh Logistics Console',
    'gate.blurb': 'Sign in with Discord to view station holds and take supply runs.',
    'gate.button': 'Sign in with Discord',
    'gate.unreachable': 'Console unreachable.',

    'sync.label': 'Last reading',
    'sync.never': 'never',

    /* ---------------------------------------------------------- généraux */
    'common.loading': 'Reading manifests…',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.close': 'Close',
    'common.retry': 'Try again',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.note': 'Note',
    'common.optional': 'optional',
    'common.failed': 'Could not load',
    'common.units': 'units',
    'common.unit': 'u',
    'common.points': 'pts',
    'common.ago': '{v} ago',

    /* ---------------------------------------------------------- missions */
    'missions.eyebrow': 'Transport orders',
    'missions.title': 'Open missions',
    'missions.allStations': 'All holds',
    'missions.filterAll': 'All',
    'missions.filterImport': 'Deliver',
    'missions.filterExport': 'Collect',
    'missions.manualTitle': 'Officer orders',
    'missions.manualHint': 'Raised by hand for a specific need — take these first.',
    'missions.autoTitle': 'Standing resupply',
    'missions.empty': 'No open missions',
    'missions.emptyHint': 'Every hold is at target, or no need has been declared yet.',

    'dir.import': 'Deliver to',
    'dir.export': 'Collect from',
    'dir.importShort': 'Inbound',
    'dir.exportShort': 'Outbound',

    'mission.needed': 'Needed',
    'mission.inHold': 'In hold',
    'mission.target': 'Target',
    'mission.pledged': 'Pledged',
    'mission.remaining': 'Remaining',
    'mission.volume': 'Volume',
    'mission.perUnit': 'per unit',
    'mission.reward': 'Reward',
    'mission.riskBonus': 'Risk bonus ×{v}',
    'mission.pointsFor': '{v} pts for the full run',
    'mission.pointsPart': '{v} pts for your share',
    'mission.rate': '{v} pts per unit',
    'mission.full': 'Fully covered',
    'mission.freeLeft': '{v} u still open',
    'mine.colWorth': 'Worth',
    'mine.estimated': 'if delivered in full',
    'board.month': 'This month',
    'board.lastMonth': 'Last month',
    'board.year': 'This year',
    'board.funds': 'Station funds',
    'board.gained': 'Earned this month',
    'board.noBaseline': 'Measuring from today',
    'board.payoutNote': 'Shares are settled on the first of next month from the pool below.',
    'mission.nobody': 'Nobody on it',
    'mission.take': 'Take this run',
    'mission.deliver': 'Log delivery',
    'mission.abandon': 'Drop',
    'mission.auto': 'auto',
    'mission.manual': 'by hand',
    'mission.loadAt': 'Pick up at',
    'mission.sellAt': 'Take it to',
    'mission.noRoute': 'Destination not set',
    'threshold.origin': 'Where to pick it up',
    'threshold.originHint': 'Shown to pilots on every inbound run for these goods. NPC base, system, another station\u2026',
    'threshold.destination': 'Where to take it',
    'threshold.destinationHint': 'Shown on outbound runs: where the goods should be sold or delivered.',

    'priority.critical': 'Critical',
    'priority.high': 'High',
    'priority.normal': 'Normal',
    'priority.low': 'Low',

    'claim.title': 'Take this run',
    'claim.qtyLabel': 'Tonnage you commit to hauling',
    'claim.qtyHint': 'Indicative — it stops three pilots hauling the same cargo.',
    'claim.qtyRequired': 'Enter the tonnage you commit to hauling.',
    'claim.confirm': 'Take it',
    'claim.done': 'Run taken. Safe flight.',

    'deliver.title': 'Log delivery',
    'deliver.qtyLabel': 'Tonnage actually hauled',
    'deliver.qtyHint': 'The hold updates at once, then the API confirms it on the next reading.',
    'deliver.confirm': 'Confirm delivery',
    'deliver.done': 'Delivery logged: {v} units, {p} points.',

    'abandon.title': 'Drop this run',
    'abandon.body': 'Your pledge on {item} will be removed. The mission stays open for others.',
    'abandon.confirm': 'Drop it',
    'abandon.done': 'Pledge withdrawn.',

    /* ------------------------------------------------------------ my runs */
    'mine.eyebrow': 'Logbook',
    'mine.title': 'My runs',
    'mine.active': 'Active pledges',
    'mine.empty': 'No active run',
    'mine.emptyHint': 'Take a mission from the board and it will show up here.',
    'mine.goToMissions': 'Browse missions',
    'mine.history': 'History',
    'mine.historyEmpty': 'Nothing logged yet',
    'mine.historyEmptyHint': 'Completed and cancelled runs are kept here.',
    'mine.colGoods': 'Goods',
    'mine.colDir': 'Way',
    'mine.colStation': 'Hold',
    'mine.colPledged': 'Pledged',
    'mine.colSince': 'Since',
    'mine.colDelivered': 'Delivered',
    'mine.colPoints': 'Points',
    'mine.colWhen': 'When',
    'mine.colStatus': 'Status',

    'status.delivered': 'Delivered',
    'status.abandoned': 'Dropped',
    'status.cancelled': 'Cancelled',
    'status.expired': 'Expired',
    'status.in_progress': 'In progress',

    'cancel.title': 'Cancel this delivery',
    'cancel.body': 'The {qty} units will be removed from {station} and the {pts} points forfeited. Use this for a mistaken or test entry.',
    'cancel.reason': 'Reason',
    'cancel.reasonHint': 'Kept in the history so officers can see what happened.',
    'cancel.confirm': 'Cancel delivery',
    'cancel.done': 'Delivery cancelled, hold restored.',
    'cancel.by': 'cancelled by {who}',

    /* ------------------------------------------------------------- holds */
    'stations.eyebrow': 'Inventory',
    'stations.title': 'Station holds',
    'stations.empty': 'No station registered',
    'stations.emptyHint': 'An officer must declare the stations before readings can fill them.',
    'stations.shortages': '{n} below target',
    'stations.onTarget': 'On target',
    'stations.hull': 'Hull',
    'stations.funds': 'Funds',
    'stations.hold': 'Hold',
    'stations.lines': 'Entries',
    'stations.readAt': 'Read {v} ago',
    'stations.colGoods': 'Goods',
    'stations.colLevel': 'Level',
    'stations.colQty': 'In hold',
    'stations.colMin': 'Floor',
    'stations.colMax': 'Ceiling',
    'stations.emptyHold': 'Empty hold',
    'stations.emptyHoldHint': 'No reading for this station. Check that its API name matches darkstat exactly.',
    'stations.pendingPart': 'incl. {v} awaiting confirmation',

    /* ------------------------------------------------------------ armory */
    'recipes.eyebrow': 'Manufacturing',
    'recipes.title': 'Armory',
    'recipes.search': 'Filter by weapon or component…',
    'recipes.empty': 'No recipes',
    'recipes.emptyHint': 'Import the Discovery recipe file from Manage, or enter them by hand.',
    'recipes.noMatch': 'No match',
    'recipes.noMatchHint': 'Try another term.',
    'recipes.buildable': 'Buildable',
    'recipes.missing': '{n} component short',
    'recipes.missingPlural': '{n} components short',
    'recipes.colComponent': 'Component',
    'recipes.colNeeded': 'Needed',
    'recipes.colWhere': 'Where to find',
    'recipes.unknownOrigin': 'Origin unknown',

    /* ------------------------------------------------------------ routes */
    'routes.eyebrow': 'Network',
    'routes.title': 'Trade routes',
    'routes.empty': 'No route declared',
    'routes.emptyHint': 'Routes say where each commodity comes from. An officer can add them from Manage.',
    'routes.external': 'Outside supplier',
    'routes.auto': 'Suggested',
    'routes.manual': 'Set by an officer',
    'routes.autoTitle': 'Suggested by market scan',
    'routes.manualTitle': 'Declared routes',
    'routes.buyAt': 'Buy at',
    'routes.sellAt': 'Sell at',
    'routes.price': '{v} cr',
    'routes.scanned': 'Market read {v} ago',
    'routes.caveat': 'Prices move with in-game stock. Treat these as a lead, not a promise.',

    /* --------------------------------------------------------- standings */
    /* ------------------------------------------------- boucles de trade */
    'loops.eyebrow': 'Round trips',
    'loops.title': 'Trade loops',
    'loops.empty': 'No loop to suggest',
    'loops.emptyHint': 'A loop needs one inbound and one outbound mission open on the same hold. Officers open them from Manage.',
    'loops.computed': 'Worked out {v} ago',
    'loops.caveat': 'Flight times come from the game jump network. Prices move with in-game stock — a loop is a lead, not a promise.',
    'loops.allStations': 'All holds',
    'loops.cargo': 'Cargo hold',
    'loops.cargoHint': 'Units your ship carries.',
    'loops.shipClass': 'Ship',
    'loops.save': 'Remember my ship',
    'loops.saved': 'Ship saved.',
    'loops.defaultCargo': 'Estimated on a reference hold of {v} units. Declare yours for real figures.',
    'loops.perHour': '{v} pts/h',
    'loops.roundTrip': 'Round trip',
    'loops.closesLoop': 'Closed loop',
    'loops.legLoad': 'Load at',
    'loops.legDeliver': 'Deliver to',
    'loops.legSell': 'Sell at',
    'loops.legReturn': 'Back to',
    'loops.spend': 'costs {v} cr',
    'loops.earn': 'pays {v} cr',
    'loops.takeInbound': 'Take the inbound leg',
    'loops.takeOutbound': 'Take the outbound leg',
    'loops.forHold': 'for {v} u',

    'ship.transport': 'Transport',
    'ship.freighter': 'Freighter',
    'ship.frigate': 'Frigate',

    'common.durationH': '{h} h {m} min',
    'common.durationM': '{m} min',

    'board.eyebrow': 'Merit',
    'board.title': 'Pilot standings',
    'board.explain': 'Points = quantity × unit volume × risk bonus. Volume levels the effort between light and bulky goods.',
    'board.empty': 'Nothing to rank yet',
    'board.emptyHint': 'Standings count merit points. They fill up as soon as runs are logged.',
    'board.runs': '{n} run',
    'board.runsPlural': '{n} runs',
    'board.days7': 'Last 7 days',
    'board.days30': 'Last 30 days',
    'board.days365': 'This year',
    'board.unitsHauled': '{v} units hauled',

    /* ------------------------------------------------------------- accès */
    'denied.title': 'Restricted area',
    'denied.body': 'This section is for officers. Ask an administrator for access.',
  },

  fr: {
    'app.title': 'Logistique Kadesh',
    'nav.missions': 'Missions',
    'nav.mine': 'Mes runs',
    'nav.stations': 'Soutes',
    'nav.recipes': 'Armurerie',
    'nav.routes': 'Routes',
    'nav.loops': 'Boucles',
    'nav.board': 'Classement',
    'nav.admin': 'Gestion',
    'nav.logout': 'Quitter',

    'role.member': 'Pilote',
    'role.officer': 'Officier',
    'role.admin': 'Administrateur',

    'gate.title': 'Console logistique Kadesh',
    'gate.blurb': 'Identifiez-vous avec Discord pour consulter les soutes et prendre des missions.',
    'gate.button': 'Se connecter avec Discord',
    'gate.unreachable': 'Console injoignable.',

    'sync.label': 'Dernier relevé',
    'sync.never': 'jamais',

    'common.loading': 'Lecture des relevés…',
    'common.cancel': 'Annuler',
    'common.save': 'Enregistrer',
    'common.close': 'Fermer',
    'common.retry': 'Réessayer',
    'common.delete': 'Supprimer',
    'common.edit': 'Modifier',
    'common.note': 'Note',
    'common.optional': 'facultatif',
    'common.failed': 'Chargement impossible',
    'common.units': 'unités',
    'common.unit': 'u',
    'common.points': 'pts',
    'common.ago': 'il y a {v}',

    'missions.eyebrow': 'Ordres de transport',
    'missions.title': 'Missions ouvertes',
    'missions.allStations': 'Toutes les soutes',
    'missions.filterAll': 'Tout',
    'missions.filterImport': 'À livrer',
    'missions.filterExport': 'À enlever',
    'missions.manualTitle': "Ordres d'officier",
    'missions.manualHint': 'Créées à la main pour un besoin précis — à prendre en priorité.',
    'missions.autoTitle': 'Réapprovisionnement automatique',
    'missions.empty': 'Aucune mission ouverte',
    'missions.emptyHint': "Les soutes sont à leur objectif, ou aucun besoin n'a été déclaré.",

    'dir.import': 'Livrer à',
    'dir.export': 'Enlever de',
    'dir.importShort': 'Entrant',
    'dir.exportShort': 'Sortant',

    'mission.needed': 'Demandé',
    'mission.inHold': 'En soute',
    'mission.target': 'Objectif',
    'mission.pledged': 'Engagé',
    'mission.remaining': 'Restant',
    'mission.volume': 'Volume',
    'mission.perUnit': "à l'unité",
    'mission.reward': 'Gain',
    'mission.riskBonus': 'Prime de risque ×{v}',
    'mission.pointsFor': '{v} pts pour la mission entière',
    'mission.pointsPart': '{v} pts pour votre part',
    'mission.rate': '{v} pts par unité',
    'mission.full': 'Entièrement couverte',
    'mission.freeLeft': '{v} u encore libres',
    'mine.colWorth': 'Vaut',
    'mine.estimated': 'si livré en entier',
    'board.month': 'Ce mois-ci',
    'board.lastMonth': 'Mois dernier',
    'board.year': 'Cette année',
    'board.funds': 'Fonds des stations',
    'board.gained': 'Gagné ce mois-ci',
    'board.noBaseline': 'Mesure depuis aujourd\'hui',
    'board.payoutNote': 'La répartition se fait le premier du mois suivant, à partir de la cagnotte ci-dessous.',
    'mission.nobody': 'Personne dessus',
    'mission.take': 'Prendre la mission',
    'mission.deliver': 'Déclarer la livraison',
    'mission.abandon': 'Abandonner',
    'mission.auto': 'auto',
    'mission.manual': 'à la main',
    'mission.loadAt': 'Charger à',
    'mission.sellAt': 'Emmener à',
    'mission.noRoute': 'Destination non renseignée',
    'threshold.origin': 'Où charger',
    'threshold.originHint': 'Affiché aux pilotes sur chaque mission entrante pour cette marchandise. Base PNJ, système, autre station\u2026',
    'threshold.destination': 'Où emmener',
    'threshold.destinationHint': 'Affiché sur les missions sortantes : où revendre ou livrer la marchandise.',

    'priority.critical': 'Critique',
    'priority.high': 'Haute',
    'priority.normal': 'Normale',
    'priority.low': 'Basse',

    'claim.title': 'Prendre la mission',
    'claim.qtyLabel': 'Tonnage que vous vous engagez à transporter',
    'claim.qtyHint': 'Indicatif : évite que trois pilotes chargent la même cargaison.',
    'claim.qtyRequired': "Indiquez le tonnage que vous vous engagez à transporter.",
    'claim.confirm': 'Prendre',
    'claim.done': 'Mission prise. Bon vol.',

    'deliver.title': 'Déclarer la livraison',
    'deliver.qtyLabel': 'Tonnage réellement transporté',
    'deliver.qtyHint': "Le stock est ajusté aussitôt, puis confirmé au prochain relevé de l'API.",
    'deliver.confirm': 'Valider la livraison',
    'deliver.done': 'Livraison enregistrée : {v} unités, {p} points.',

    'abandon.title': 'Abandonner la mission',
    'abandon.body': 'Votre engagement sur {item} sera retiré. La mission reste ouverte pour les autres.',
    'abandon.confirm': 'Abandonner',
    'abandon.done': 'Engagement retiré.',

    'mine.eyebrow': 'Carnet de bord',
    'mine.title': 'Mes runs',
    'mine.active': 'Engagements en cours',
    'mine.empty': 'Aucun run en cours',
    'mine.emptyHint': 'Prenez une mission depuis le tableau pour la voir apparaître ici.',
    'mine.goToMissions': 'Voir les missions',
    'mine.history': 'Historique',
    'mine.historyEmpty': 'Rien à afficher',
    'mine.historyEmptyHint': 'Les runs terminés et annulés sont conservés ici.',
    'mine.colGoods': 'Marchandise',
    'mine.colDir': 'Sens',
    'mine.colStation': 'Soute',
    'mine.colPledged': 'Engagé',
    'mine.colSince': 'Depuis',
    'mine.colDelivered': 'Livré',
    'mine.colPoints': 'Points',
    'mine.colWhen': 'Quand',
    'mine.colStatus': 'État',

    'status.delivered': 'Livré',
    'status.abandoned': 'Abandonné',
    'status.cancelled': 'Annulé',
    'status.expired': 'Expiré',
    'status.in_progress': 'En cours',

    'cancel.title': 'Annuler cette livraison',
    'cancel.body': 'Les {qty} unités seront retirées de {station} et les {pts} points perdus. À utiliser pour une saisie erronée ou un essai.',
    'cancel.reason': 'Motif',
    'cancel.reasonHint': "Conservé dans l'historique pour que les officiers sachent ce qui s'est passé.",
    'cancel.confirm': 'Annuler la livraison',
    'cancel.done': 'Livraison annulée, soute rétablie.',
    'cancel.by': 'annulé par {who}',

    'stations.eyebrow': 'Inventaire',
    'stations.title': 'Soutes',
    'stations.empty': 'Aucune station enregistrée',
    'stations.emptyHint': 'Un officier doit déclarer les stations pour que les relevés les remplissent.',
    'stations.shortages': '{n} sous objectif',
    'stations.onTarget': 'Objectifs tenus',
    'stations.hull': 'Coque',
    'stations.funds': 'Fonds',
    'stations.hold': 'Soute',
    'stations.lines': 'Références',
    'stations.readAt': 'Relevé il y a {v}',
    'stations.colGoods': 'Marchandise',
    'stations.colLevel': 'Niveau',
    'stations.colQty': 'En soute',
    'stations.colMin': 'Plancher',
    'stations.colMax': 'Plafond',
    'stations.emptyHold': 'Soute vide',
    'stations.emptyHoldHint': "Aucun relevé. Vérifiez que le nom API correspond exactement à celui de darkstat.",
    'stations.pendingPart': 'dont {v} en attente',

    'recipes.eyebrow': 'Fabrication',
    'recipes.title': 'Armurerie',
    'recipes.search': 'Filtrer par arme ou composant…',
    'recipes.empty': 'Aucune recette',
    'recipes.emptyHint': 'Importez le fichier Discovery depuis la gestion, ou saisissez-les à la main.',
    'recipes.noMatch': 'Aucun résultat',
    'recipes.noMatchHint': 'Essayez un autre terme.',
    'recipes.buildable': 'Fabricable',
    'recipes.missing': '{n} composant à couvrir',
    'recipes.missingPlural': '{n} composants à couvrir',
    'recipes.colComponent': 'Composant',
    'recipes.colNeeded': 'Requis',
    'recipes.colWhere': 'Où en trouver',
    'recipes.unknownOrigin': 'Origine inconnue',

    'routes.eyebrow': 'Réseau',
    'routes.title': 'Routes commerciales',
    'routes.empty': 'Aucune route déclarée',
    'routes.emptyHint': "Les routes disent d'où provient chaque marchandise. Un officier peut les ajouter.",
    'routes.external': 'Fournisseur extérieur',
    'routes.auto': 'Suggérée',
    'routes.manual': 'Fixée par un officier',
    'routes.autoTitle': 'Suggestions du marché',
    'routes.manualTitle': 'Routes déclarées',
    'routes.buyAt': 'Acheter à',
    'routes.sellAt': 'Revendre à',
    'routes.price': '{v} cr',
    'routes.scanned': 'Marché relevé il y a {v}',
    'routes.caveat': 'Les prix suivent le stock en jeu. À prendre comme une piste, pas comme une garantie.',

    /* ------------------------------------------------- boucles de trade */
    'loops.eyebrow': 'Circuits',
    'loops.title': 'Boucles de trade',
    'loops.empty': 'Aucune boucle à proposer',
    'loops.emptyHint': "Une boucle demande une mission d'apport ET une mission d'enlèvement ouvertes sur la même station. Un officier les ouvre depuis la gestion.",
    'loops.computed': 'Calculé il y a {v}',
    'loops.caveat': "Les temps de vol viennent du réseau de sauts du jeu. Les prix suivent le stock — une boucle est une piste, pas une garantie.",
    'loops.allStations': 'Toutes les stations',
    'loops.cargo': 'Cale',
    'loops.cargoHint': 'Unités que votre vaisseau emporte.',
    'loops.shipClass': 'Vaisseau',
    'loops.save': 'Retenir mon vaisseau',
    'loops.saved': 'Vaisseau enregistré.',
    'loops.defaultCargo': 'Estimé sur une cale de référence de {v} unités. Déclarez la vôtre pour des chiffres justes.',
    'loops.perHour': '{v} pts/h',
    'loops.roundTrip': 'Circuit complet',
    'loops.closesLoop': 'Boucle fermée',
    'loops.legLoad': 'Charger à',
    'loops.legDeliver': 'Livrer à',
    'loops.legSell': 'Revendre à',
    'loops.legReturn': 'Retour vers',
    'loops.spend': 'coûte {v} cr',
    'loops.earn': 'rapporte {v} cr',
    'loops.takeInbound': "S'engager sur l'aller",
    'loops.takeOutbound': "S'engager sur le retour",
    'loops.forHold': 'pour {v} u',

    'ship.transport': 'Transport',
    'ship.freighter': 'Cargo',
    'ship.frigate': 'Frégate',

    'common.durationH': '{h} h {m} min',
    'common.durationM': '{m} min',

    'board.eyebrow': 'Mérite',
    'board.title': 'Classement des pilotes',
    'board.explain': "Points = quantité × volume unitaire × prime de risque. Le volume égalise l'effort entre marchandises légères et encombrantes.",
    'board.empty': 'Rien à classer',
    'board.emptyHint': 'Le classement compte les points de mérite. Il se remplit dès les premiers runs.',
    'board.runs': '{n} run',
    'board.runsPlural': '{n} runs',
    'board.days7': '7 derniers jours',
    'board.days30': '30 derniers jours',
    'board.days365': 'Cette année',
    'board.unitsHauled': '{v} unités transportées',

    'denied.title': 'Accès réservé',
    'denied.body': 'Cette section est réservée aux officiers. Demandez à un administrateur.',
  },
};

const DISPONIBLES = ['en', 'fr'];
const CLE = 'kadesh.lang';

/** Anglais par défaut ; la langue du navigateur ne sert que de suggestion. */
function langueInitiale() {
  try {
    const memo = localStorage.getItem(CLE);
    if (memo && DISPONIBLES.includes(memo)) return memo;
  } catch { /* stockage indisponible */ }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DISPONIBLES.includes(nav) ? nav : 'en';
}

export let lang = langueInitiale();

export function setLang(next) {
  if (!DISPONIBLES.includes(next)) return;
  lang = next;
  try { localStorage.setItem(CLE, next); } catch { /* sans conséquence */ }
  document.documentElement.lang = next;
}

export const languages = DISPONIBLES;

/**
 * t('mission.take') ou t('board.runs', { n: 3 })
 * Une clé absente est renvoyée telle quelle : visible en test, sans casser
 * l'affichage en production.
 */
export function t(key, vars = null) {
  const table = DICT[lang] || DICT.en;
  let out = table[key] ?? DICT.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

/** Pluriel simple : t2('board.runs', n) choisit la forme plurielle. */
export function t2(key, n, vars = {}) {
  return t(n > 1 ? `${key}Plural` : key, { n, ...vars });
}

document.documentElement.lang = lang;
