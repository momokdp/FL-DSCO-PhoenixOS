import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`[config] Variable manquante : ${key}. Copiez .env.example vers .env et renseignez-la.`);
    process.exit(1);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.PORT || 3000),

  // Interface d'écoute. Par défaut la boucle locale : l'application n'est
  // joignable que par le proxy inverse, jamais directement depuis Internet.
  // Mettre 0.0.0.0 uniquement si vous servez sans proxy devant.
  host: process.env.HOST || '127.0.0.1',
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),

  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'kadesh.sqlite'),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),

  session: {
    secret: required('SESSION_SECRET'),
    // 30 jours : les pilotes ne se reconnectent pas à chaque vol
    maxAgeMs: 1000 * 60 * 60 * 24 * 30,
  },

  discord: {
    clientId: required('DISCORD_CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    // Doit être déclarée à l'identique dans le portail développeur Discord
    redirectUri: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '') + '/auth/discord/callback',
    // Optionnel : n'autoriser que les membres d'un serveur donné
    guildId: process.env.DISCORD_GUILD_ID || null,
  },

  // Les identifiants Discord listés ici obtiennent le rôle admin à la connexion
  bootstrapAdmins: (process.env.BOOTSTRAP_ADMIN_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  darkstat: {
    baseUrl: process.env.DARKSTAT_URL || 'https://darkstat.dd84ai.com',
    pobsPath: '/api/pobs',
    intervalMs: Number(process.env.SYNC_INTERVAL_MINUTES || 10) * 60 * 1000,

    // Les prix de marché évoluent bien plus lentement que les stocks : une
    // analyse horaire suffit, et évite deux appels d'API tous les quarts
    // d'heure pour un résultat quasi identique.
    routesIntervalMs: Number(process.env.ROUTES_INTERVAL_MINUTES || 60) * 60 * 1000,
    timeoutMs: Number(process.env.SYNC_TIMEOUT_MS || 20000),

    // /api/graph/paths accepte un tableau de couples : 400 couples reviennent
    // en une fraction de seconde. Interroger couple par couple rendrait la
    // mesure du temps de trajet trop chère pour servir au classement.
    pathsBatchSize: Number(process.env.PATHS_BATCH_SIZE || 400),

    // La carte du jeu ne bouge pas : un temps mesuré reste valable jusqu'à
    // ce que le serveur ouvre un nouveau passage. On réinterroge malgré
    // tout au bout d'un mois, pour ne pas figer une erreur indéfiniment.
    pathsMaxAgeDays: Number(process.env.PATHS_MAX_AGE_DAYS || 30),
  },

  // ------------------------------------------------------ boucles de trade
  loops: {
    // Cale servant à classer les circuits au moment du calcul. Le pilote
    // déclare la sienne et l'écran refait le score à sa mesure ; cette
    // valeur ne sert qu'à retenir les meilleurs candidats en amont.
    refCargo: Number(process.env.LOOPS_REF_CARGO || 5000),

    // Nombre d'offres retenues par mission. La moins chère n'est pas
    // toujours la meilleure une fois le trajet compté : il faut plusieurs
    // candidats pour que la distance ait son mot à dire.
    offresParMission: Number(process.env.LOOPS_OFFERS_PER_MISSION || 5),

    // Segments conservés de chaque côté avant d'éprouver les couples.
    // Mesurer le retour de tous les B vers tous les A coûterait le carré du
    // nombre de candidats ; on n'éprouve que les meilleurs de chaque bord.
    segmentsParBord: Number(process.env.LOOPS_LEGS_PER_SIDE || 8),

    // Circuits gardés par station. Au-delà, l'écran devient un catalogue
    // et le pilote ne choisit plus.
    parStation: Number(process.env.LOOPS_PER_STATION || 12),
  },

  // Fichier de recettes Discovery, importable depuis l'administration
  recipeSourceUrl: process.env.RECIPE_SOURCE_URL
    || 'https://discoverygc.com/gameconfigpublic/base_recipe_items.cfg',
};
