import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { db, audit } from '../db/index.js';

export const authRouter = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = config.discord.guildId ? 'identify guilds' : 'identify';

authRouter.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.returnTo = typeof req.query.next === 'string' ? req.query.next : '/';

  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.discord.clientId);
  url.searchParams.set('redirect_uri', config.discord.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

authRouter.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send(errorPage('Connexion refusée', 'Le jeton de sécurité ne correspond pas. Relancez la connexion depuis la page d’accueil.'));
  }
  delete req.session.oauthState;

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.discord.redirectUri,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Échange du code refusé (HTTP ${tokenRes.status})`);
    const token = await tokenRes.json();

    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) throw new Error(`Profil illisible (HTTP ${meRes.status})`);
    const me = await meRes.json();

    // Filtrage par serveur : seul un membre du Discord de la faction entre.
    if (config.discord.guildId) {
      const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const guilds = guildsRes.ok ? await guildsRes.json() : [];
      if (!guilds.some(g => g.id === config.discord.guildId)) {
        return res.status(403).send(errorPage(
          'Accès réservé',
          'Cette console est ouverte aux membres du Discord de la faction. Rejoignez-le puis reconnectez-vous.'
        ));
      }
    }

    const user = upsertUser(me);
    if (!user.active) {
      return res.status(403).send(errorPage(
        'Compte suspendu',
        'Un administrateur a désactivé cet accès. Contactez l’état-major de la faction.'
      ));
    }

    req.session.userId = user.id;
    const next = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(next);

  } catch (err) {
    console.error('[auth] échec OAuth :', err);
    res.status(502).send(errorPage('Discord ne répond pas', 'La connexion a échoué en cours de route. Réessayez dans un instant.'));
  }
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

function upsertUser(profile) {
  const avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64`
    : null;
  const display = profile.global_name || profile.username;

  const existing = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(profile.id);

  if (existing) {
    db.prepare(`
      UPDATE users SET username = ?, display_name = ?, avatar = ?, last_login_at = datetime('now')
      WHERE id = ?
    `).run(profile.username, display, avatar, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }

  // Premier compte créé, ou identifiant listé dans BOOTSTRAP_ADMIN_IDS : admin.
  const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  const role = (isFirst || config.bootstrapAdmins.includes(profile.id)) ? 'admin' : 'member';

  const info = db.prepare(`
    INSERT INTO users (discord_id, username, display_name, avatar, callsign, role, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(profile.id, profile.username, display, avatar, display, role);

  audit(info.lastInsertRowid, 'user.created', 'users', info.lastInsertRowid, { role });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function errorPage(title, message) {
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
  body{background:#0A0E14;color:#C6D0DB;font:16px/1.6 system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
  div{max-width:38ch;border-left:3px solid #E8A33D;padding-left:1.25rem}
  h1{font-size:1.1rem;letter-spacing:.12em;text-transform:uppercase;color:#E8A33D;margin:0 0 .75rem}
  a{color:#4EC9D9}
</style>
<div><h1>${title}</h1><p>${message}</p><p><a href="/">Retour à la console</a></p></div>`;
}
