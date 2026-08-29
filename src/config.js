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
    timeoutMs: Number(process.env.SYNC_TIMEOUT_MS || 20000),
  },

  // Fichier de recettes Discovery, importable depuis l'administration
  recipeSourceUrl: process.env.RECIPE_SOURCE_URL
    || 'https://discoverygc.com/gameconfigpublic/base_recipe_items.cfg',
};
