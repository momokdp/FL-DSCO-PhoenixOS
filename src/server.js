import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import connectSqlite3 from 'connect-sqlite3';

import { config, ROOT } from './config.js';
import { migrate, db } from './db/index.js';
import { authRouter } from './auth/discord.js';
import { loadUser, requireAuth, requireRole } from './auth/middleware.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { startSyncWorker, stopSyncWorker } from './sync/darkstat.js';
import { startRoutesWorker, stopRoutesWorker } from './sync/routes.js';
import { refreshAutoMissions } from './services/missions.js';

// Le serveur ne démarre pas sur une base dont le schéma n'est pas à jour :
// mieux vaut un refus net qu'un service qui répond en échouant requête après
// requête. systemd consigne ce message dans journalctl.
try {
  const { applied, backup } = migrate();
  if (applied.length) {
    if (backup) console.log(`[migration] sauvegarde préalable : ${backup}`);
    console.log(`[migration] ${applied.length} migration(s) appliquée(s).`);
  }
} catch (err) {
  console.error(`\n  Mise à jour du schéma impossible.\n  ${err.message}\n`);
  process.exit(1);
}

const app = express();
const SQLiteStore = connectSqlite3(session);

app.set('trust proxy', 1); // derrière IIS / ARR

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: config.dataDir }),
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  name: 'kadesh.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    maxAge: config.session.maxAgeMs,
  },
}));

app.use(loadUser);

// Le flux SSE est exclu : il reste ouvert en permanence.
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/events',
  message: { error: 'Trop de requêtes. Patientez une minute.' },
}));

app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/api/admin', requireAuth, requireRole('officer'), adminRouter);

app.use(express.static(path.join(ROOT, 'public'), {
  maxAge: config.env === 'production' ? '1h' : 0,
  index: false,
}));

app.get('/healthz', (_req, res) => {
  const stations = db.prepare('SELECT COUNT(*) AS n FROM stations WHERE active = 1').get().n;
  res.json({ status: 'ok', stations, uptime: Math.round(process.uptime()) });
});

// Toutes les autres URL renvoient la coque : le routage se fait côté client.
// Une URL /api inconnue doit renvoyer du JSON, pas la page de l'application :
// sinon le client reçoit du HTML en réponse à un appel d'API et ne peut pas
// distinguer une faute de frappe d'un proxy mal configuré.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Route inconnue : ${req.method} /api${req.path}` });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[erreur]', err);
  res.status(500).json({ error: "Le serveur n'a pas pu traiter la demande." });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  Console Kadesh — ${config.baseUrl}`);
  console.log(`  Base : ${config.dbFile}`);
  console.log(`  Écoute sur ${config.host}:${config.port}\n`);
  startSyncWorker();
  startRoutesWorker();
  setInterval(() => { try { refreshAutoMissions(); } catch (e) { console.error('[missions]', e.message); } }, 120_000);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nArrêt en cours…');
    stopSyncWorker();
  stopRoutesWorker();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000);
  });
}
