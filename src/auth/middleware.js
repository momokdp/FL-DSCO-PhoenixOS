import { db } from '../db/index.js';

const RANK = { member: 1, officer: 2, admin: 3 };

/** Charge l'utilisateur de session sur req.user, sans bloquer les anonymes. */
export function loadUser(req, _res, next) {
  req.user = null;
  if (req.session?.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (user) req.user = user;
    else req.session.destroy(() => {});
  }
  next();
}

/** Exige une session valide. */
export function requireAuth(req, res, next) {
  if (req.user) return next();

  // Un appel à /api doit toujours obtenir du JSON. Rediriger vers Discord
  // ferait suivre la redirection à fetch(), qui échouerait ensuite sur une
  // réponse HTML : le client ne saurait pas que la session a expiré.
  // On ne se fie pas à l'en-tête Accept, que fetch() laisse à « */* ».
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Connectez-vous pour continuer.' });
  }

  res.redirect('/auth/discord?next=' + encodeURIComponent(req.originalUrl));
}

/** Exige un rôle au moins égal à celui demandé. */
export function requireRole(minimum) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Connectez-vous pour continuer.' });
    if (RANK[req.user.role] >= RANK[minimum]) return next();
    res.status(403).json({ error: "Votre rôle ne permet pas cette action." });
  };
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    callsign: user.callsign,
    avatar: user.avatar,
    role: user.role,
    // Le vaisseau déclaré : les boucles de trade sont mises à son échelle.
    // null tant que le pilote n'a rien renseigné — l'écran le signale au
    // lieu de laisser croire à une estimation faite sur sa cale réelle.
    cargoCapacity: user.cargo_capacity ?? null,
    shipClass: user.ship_class ?? null,
  };
}
