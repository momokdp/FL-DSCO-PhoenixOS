#!/usr/bin/env bash
# =====================================================================
#  Installe la console Kadesh sur Debian 12 ou Ubuntu 22.04+.
#
#  À lancer depuis la racine du projet, en root :
#      sudo bash install/install-debian.sh
#
#  Le script est rejouable : le relancer après une mise à jour du code
#  réinstalle les dépendances et redémarre le service sans rien perdre.
# =====================================================================

set -euo pipefail

APP_USER="kadesh"
APP_DIR="/opt/kadesh"
SERVICE="kadesh"
NODE_MAJOR="20"

bleu()  { printf '\033[36m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
jaune() { printf '\033[33m%s\033[0m\n' "$*"; }
rouge() { printf '\033[31m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { rouge "Ce script doit être lancé avec sudo."; exit 1; }

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bleu "Source : $SOURCE_DIR"
bleu "Cible  : $APP_DIR"
echo

# ---------------------------------------------------------------- Node.js
if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  jaune "Installation de Node.js ${NODE_MAJOR}.x…"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
vert "Node.js $(node -v)"

# better-sqlite3 est un module natif. Des binaires précompilés existent pour
# les versions courantes de Node ; à défaut, il se compile, d'où ces paquets.
apt-get install -y -qq python3 g++ make >/dev/null

# ------------------------------------------------------ utilisateur dédié
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  jaune "Création de l'utilisateur système $APP_USER…"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# ------------------------------------------------------------- déploiement
mkdir -p "$APP_DIR"

if [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  jaune "Copie du code vers $APP_DIR…"
  # data/ et .env sont préservés : ils contiennent la base et les secrets.
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude '.git' \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

mkdir -p "$APP_DIR/data"

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" "$APP_DIR/.env"
  jaune "Un .env a été créé avec un SESSION_SECRET aléatoire."
  ENV_A_REMPLIR=1
fi

jaune "Installation des dépendances…"
cd "$APP_DIR"
sudo -u "$APP_USER" -H npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3 \
  || npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"
chmod 750 "$APP_DIR/data"

# ----------------------------------------------------------------- service
jaune "Installation du service systemd…"
cp "$APP_DIR/install/kadesh.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1

if [ "${ENV_A_REMPLIR:-0}" = "1" ]; then
  echo
  jaune "───────────────────────────────────────────────────────────"
  jaune " Le service n'est pas démarré : le .env doit être complété."
  jaune "───────────────────────────────────────────────────────────"
  echo "   sudo nano $APP_DIR/.env"
  echo
  echo " Renseignez BASE_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET"
  echo " et BOOTSTRAP_ADMIN_IDS, puis :"
  echo
  echo "   sudo systemctl start $SERVICE"
  echo
  exit 0
fi

systemctl restart "$SERVICE"
sleep 3

echo
if systemctl is-active --quiet "$SERVICE"; then
  vert "  Service démarré."
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 3000)"
  echo "  Vérification : curl http://localhost:${PORT:-3000}/healthz"
else
  rouge "  Le service n'a pas démarré."
  echo "  Cause probable dans :  journalctl -u $SERVICE -n 40 --no-pager"
fi

echo
echo "  Commandes utiles :"
echo "    sudo systemctl restart $SERVICE"
echo "    sudo systemctl status  $SERVICE"
echo "    sudo journalctl -u $SERVICE -f"
echo
