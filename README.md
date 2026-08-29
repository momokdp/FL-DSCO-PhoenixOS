# Console logistique Kadesh

Suivi des soutes, des missions d'approvisionnement et des recettes de fabrication
pour un groupe de bases joueur sur Discovery Freelancer.

L'application remplace l'ensemble « tableur + Apps Script + runner GitHub » :
un seul processus Node.js, un seul fichier de base de données, tout se
paramètre depuis l'interface.

---

## Ce que fait l'application

- **Relevé automatique** des soutes depuis l'API darkstat, toutes les 10 minutes.
- **Missions ouvertes toutes seules** dès qu'une marchandise passe sous son seuil bas.
- **Prise de mission à plusieurs** : chaque pilote s'engage sur un tonnage, personne
  ne bloque la mission pour les autres.
- **Stock effectif en direct** : une livraison est visible immédiatement, avant même
  que l'API l'ait confirmée.
- **Armurerie** : recettes de fabrication avec le stock de chaque composant, station
  par station, et ce qu'il reste à couvrir.
- **Gestion complète** depuis le site : stations, marchandises, routes, recettes,
  missions, rôles des pilotes.

### Le principe à retenir

L'API darkstat est la **seule source de vérité** pour les quantités en soute.
Une livraison déclarée par un pilote n'écrase jamais un stock : elle crée un
*ajustement* qui se superpose au dernier relevé, puis devient caduc dès que l'API
confirme la livraison.

C'est ce qui évite le problème du montage précédent, où le scraper et les missions
écrivaient dans les mêmes cellules et s'écrasaient mutuellement. Ici, si un pilote
se trompe ou si une livraison échoue en jeu, le prochain relevé corrige tout seul.

---

## Installation

### En une commande

Sur un VPS Debian 12 fraîchement créé, connecté en root :

```bash
apt update && apt install -y git rsync
git clone <votre-dépôt> /root/kadesh   # ou envoyez l'archive par scp
cd /root/kadesh
sudo bash install/install-debian.sh
```

Le script installe Node.js, crée un utilisateur système `kadesh` sans shell,
déploie dans `/opt/kadesh`, génère un `SESSION_SECRET` aléatoire et installe
le service systemd. Il s'arrête ensuite pour vous laisser compléter le `.env`.

### Configurer

```bash
sudo nano /opt/kadesh/.env
```

Renseignez `BASE_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` et
`BOOTSTRAP_ADMIN_IDS` (voir « Créer l'application Discord » plus bas), puis :

```bash
sudo systemctl start kadesh
curl http://localhost:3000/healthz
```

### Publier sur Internet

```bash
apt install -y nginx certbot python3-certbot-nginx
cp /opt/kadesh/install/nginx-kadesh.conf /etc/nginx/sites-available/kadesh
nano /etc/nginx/sites-available/kadesh          # remplacer server_name
ln -s /etc/nginx/sites-available/kadesh /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d logistique.exemple.fr
```

Le fichier fourni contient déjà le bloc `/api/events` nécessaire au temps réel.
Sans lui, nginx met les événements en tampon et l'interface ne se rafraîchit
jamais toute seule.

### Pare-feu

`ufw` n'est pas installé sur les images Debian minimales :

```bash
sudo apt install -y ufw
```

> **Autorisez SSH avant d'activer le pare-feu.** `ufw enable` bloque tout le
> trafic entrant, y compris votre session en cours. Sans la règle OpenSSH,
> vous perdez l'accès à la machine et devez passer par la console KVM d'OVH.

Une commande à la fois, en vérifiant entre les deux :

```bash
sudo ufw allow OpenSSH
sudo ufw status
sudo ufw allow 'Nginx Full'    # ce profil n'existe qu'une fois nginx installé
sudo ufw enable
```

Le port 3000 n'a pas besoin d'être ouvert : l'application n'écoute que sur
`127.0.0.1`, nginx l'atteint en local. C'est le réglage `HOST` du `.env` ;
ne le passez à `0.0.0.0` que si vous servez sans proxy inverse, ce qui vous
priverait alors du HTTPS.

#### Comment les missions s'ouvrent

Les missions visent un **objectif**, pas un seuil d'alerte.

| Sens | Objectif visé | Mission ouverte tant que | Quantité demandée |
|---|---|---|---|
| **Import** (consommé) | Plafond | le stock est sous le plafond | plafond − stock |
| **Export** (produit) | Seuil bas | le stock dépasse le seuil bas | stock − seuil bas |

Le seuil opposé sert à marquer l'**urgence** : une marchandise importée qui
passe sous son seuil bas, ou une marchandise produite qui déborde son
plafond, passe en priorité critique.

Autrement dit, on ne comble pas jusqu'au minimum vital : on remplit jusqu'en
haut, et on vide jusqu'en bas.

> **Garde-fou.** Un plafond supérieur à 5 000 000 est ignoré : en jeu, une
> valeur comme 999 999 999 sert à laisser n'importe qui vendre sans butoir et
> n'exprime aucun besoin réel. La marchandise reste sans mission tant qu'un
> officier n'a pas fixé un plafond vraisemblable dans **Gestion → Seuils**.

### Affiner les seuils

Les seuils renvoyés par l'API décrivent la configuration de la base *en jeu*,
qui sert souvent un autre but que le vôtre. Un plafond à 999 999 999 existe
pour laisser n'importe quel joueur venir vendre sans butoir : il ne dit rien
de la quantité dont votre production a réellement besoin.

**Gestion → Seuils** permet de fixer vos propres valeurs, station par station
et marchandise par marchandise. Elles remplacent celles de l'API pour tout ce
que fait la console : jauges, niveaux d'alerte et surtout ouverture
automatique des missions.

Trois propriétés à connaître :

- **La station en jeu n'est pas touchée.** Les joueurs extérieurs continuent
  de vendre selon la configuration d'origine.
- **Les relevés n'écrasent jamais vos réglages.** Ils vivent dans une table
  distincte de celle que la synchronisation réécrit.
- **Chaque seuil est indépendant.** Laisser un champ vide conserve la valeur
  de l'API pour ce seuil-là seulement.

Réservé aux officiers et aux administrateurs. Le bouton « Supprimer » d'une
ligne réglée rétablit les valeurs de l'API.

---

## Exploitation

```bash
sudo systemctl restart kadesh
sudo systemctl status  kadesh
sudo journalctl -u kadesh -f          # journaux en direct
sudo journalctl -u kadesh --since "1 hour ago"
```

Pour mettre à jour le code, réappliquez le script depuis la nouvelle source :
il préserve `data/` et `.env`.

```bash
cd /root/kadesh && git pull && sudo bash install/install-debian.sh
```

---

## Premiers pas

1. Connectez-vous avec Discord : votre compte est promu administrateur.
2. **Gestion → Stations** : déclarez vos bases.
   Le champ *Nom exact dans l'API* doit reprendre au caractère près le nom
   renvoyé par darkstat, par exemple `Kadesh Orbital City`. C'est la cause
   numéro un de soute qui reste vide.
3. **Gestion → Synchronisation → Lancer un relevé.** Marchandises et stocks se
   créent tout seuls.
4. Les missions s'ouvrent automatiquement pour tout ce qui passe sous le seuil bas.
5. **Gestion → Recettes → Importer depuis Discovery** pour peupler l'armurerie.
6. **Gestion → Pilotes** : donnez le rôle *officier* à ceux qui doivent gérer
   stations et missions.

### Les trois rôles

| Rôle | Peut faire |
|---|---|
| **Pilote** | Consulter, prendre des missions, déclarer ses livraisons |
| **Officier** | Idem, plus stations, marchandises, routes, recettes, missions, relevés |
| **Administrateur** | Idem, plus les rôles des pilotes, les suppressions et l'import de recettes |

La console refuse de retirer son rôle au dernier administrateur actif.

---

## Exploitation

### Sauvegarde

Tout tient dans `data/kadesh.sqlite`. La base étant en mode WAL, ne copiez
jamais le fichier seul pendant que le service tourne : vous obtiendriez une
sauvegarde tronquée. Utilisez la sauvegarde à chaud de SQLite, qui produit un
fichier cohérent sans arrêter le service.

Sur Debian, créez `/opt/kadesh/sauvegarde.sh` :

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/kadesh
DEST="data/sauvegardes/$(date +%F).sqlite"
mkdir -p data/sauvegardes
node -e "require('better-sqlite3')('data/kadesh.sqlite').backup('$DEST')"
find data/sauvegardes -name '*.sqlite' -mtime +30 -delete
```

Puis une tâche quotidienne :

```bash
chmod +x /opt/kadesh/sauvegarde.sh
sudo crontab -u kadesh -e
# 0 4 * * *  /opt/kadesh/sauvegarde.sh
```

Pensez à recopier ces fichiers hors du serveur : une sauvegarde qui ne quitte
pas la machine ne protège de rien.



### Diagnostic

| Symptôme | Piste |
|---|---|
| Une soute reste vide | *Nom exact dans l'API* mal orthographié. Comparez avec la réponse de `/api/pobs`. |
| `invalid_redirect_uri` à la connexion | L'URL de redirection Discord ne correspond pas exactement à `BASE_URL` + `/auth/discord/callback`. |
| Relevés en échec | Consultez **Gestion → Synchronisation** : la colonne *Message* donne la cause. |
| Les mises à jour n'arrivent pas en direct | Mise en tampon du proxy : vérifiez le bloc `/api/events` de nginx. |
| `EACCES` au démarrage sous Linux | `data/` n'appartient pas à l'utilisateur `kadesh`. `sudo chown -R kadesh:kadesh /opt/kadesh`. |
| Personne n'est administrateur | Ajoutez l'identifiant dans `BOOTSTRAP_ADMIN_IDS` et redémarrez le service. |

### Réglages utiles

- `SYNC_INTERVAL_MINUTES` — fréquence des relevés. Descendre sous 5 minutes
  sollicite l'API sans bénéfice réel.
- `DISCORD_GUILD_ID` — restreint l'accès aux membres d'un serveur Discord donné.

---

---

## Mettre à jour

La base de données n'est **jamais** effacée lors d'une mise à jour. Le code est
remplacé, les données restent.

### La procédure

```bash
cd /root/kadesh
git pull
sudo bash install/install-debian.sh
```

Le script recopie le code vers `/opt/kadesh` en préservant `data/` et `.env`,
réinstalle les dépendances, puis redémarre le service. Le serveur applique au
démarrage les migrations en attente, après avoir sauvegardé la base.

Pour vérifier avant de redémarrer :

```bash
cd /opt/kadesh && sudo -u kadesh npm run migrate
```

### Comment les migrations fonctionnent

Chaque fichier de `src/db/migrations/` n'est appliqué qu'une seule fois, dans
l'ordre de son numéro. Une table `schema_migrations` retient ce qui a déjà été
joué.

Trois garanties :

- **Sauvegarde automatique** avant toute migration sur une base existante,
  dans `data/sauvegardes/`.
- **Tout ou rien** : chaque fichier s'exécute dans une transaction. Si une
  instruction échoue, celles qui précèdent dans le même fichier sont annulées
  et la migration n'est pas marquée comme appliquée.
- **Refus de démarrer** si le schéma ne peut pas être mis à jour, plutôt qu'un
  service qui répond en échouant à chaque requête.

### Écrire une migration

Créez un fichier numéroté, jamais deux fois le même numéro :

```sql
-- src/db/migrations/002-alertes-discord.sql

ALTER TABLE stations ADD COLUMN discord_webhook TEXT;

CREATE TABLE IF NOT EXISTS alertes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Trois règles :

1. **Ne modifiez jamais une migration déjà déployée.** Elle ne sera pas rejouée.
   Une correction se fait dans un nouveau fichier.
2. **Une colonne ajoutée doit accepter `NULL` ou avoir une valeur par défaut.**
   SQLite refuse d'ajouter une colonne `NOT NULL` sans défaut à une table qui
   contient déjà des lignes.
3. **`ALTER TABLE` de SQLite est limité** : ajouter une colonne et renommer sont
   possibles, en supprimer une ou changer son type ne l'est pas directement. Il
   faut alors créer la nouvelle table, recopier les données, supprimer
   l'ancienne, renommer — le tout dans le même fichier, donc dans la même
   transaction.

### Revenir en arrière

Les migrations ne se défont pas automatiquement. En cas de problème :

```bash
sudo systemctl stop kadesh
cd /opt/kadesh
sudo -u kadesh cp data/sauvegardes/avant-migration-AAAA-MM-JJ-*.sqlite data/kadesh.sqlite
cd /root/kadesh && git checkout <version-précédente>
sudo bash install/install-debian.sh
```

Restaurer la sauvegarde **et** revenir au code précédent : une base restaurée
sous du code récent réappliquerait la migration.

---

## Organisation du code

```
src/
  server.js              point d'entrée, middlewares, arrêt propre
  config.js              lecture et validation du .env
  db/
    migrations/          fichiers numérotés, appliqués une seule fois
    index.js             connexion, migrations, sauvegarde, audit
  auth/
    discord.js           parcours OAuth2
    middleware.js        session, contrôle des rôles
  sync/
    darkstat.js          relevé périodique de l'API
  services/
    stock.js             lecture des soutes
    missions.js          ouverture auto, prise, livraison, classement
    recipeImport.js      import du fichier de recettes Discovery
    events.js            diffusion temps réel
  routes/
    api.js               lecture, réservé aux pilotes connectés
    admin.js             écriture, réservé aux officiers et administrateurs
public/
  index.html             coque
  css/app.css            feuille de style unique
  js/
    ui.js                requêtes, modales, notifications, jauge
    views.js             vues pilote
    admin.js             console de gestion
    app.js               routage et flux temps réel
```

Aucune étape de compilation : le navigateur charge directement les modules.
Modifier un fichier de `public/` et rafraîchir suffit.

---

## Points de vigilance

**Précision des horodatages.** Le stock effectif ne retient que les livraisons
postérieures au dernier relevé. Les horodatages sont donc à la milliseconde, et
le relevé est daté *avant* l'appel réseau. Si vous touchez à `nowSql()` ou à
`writeSnapshots()`, gardez ces deux propriétés : sinon les livraisons déclarées
pendant une synchronisation disparaissent de l'affichage jusqu'au relevé suivant.

**Unicité des missions.** Un index unique partiel garantit une seule mission
*ouverte* par station, marchandise et sens. Les missions closes s'accumulent
librement : c'est l'historique, et c'est ce qui alimente le classement.

**Réponses de l'API.** Tout ce qui vit sous `/api` répond en JSON, y compris les
erreurs d'authentification. Ne remplacez jamais le 401 par une redirection : le
client suivrait la redirection et échouerait sur une réponse HTML.
