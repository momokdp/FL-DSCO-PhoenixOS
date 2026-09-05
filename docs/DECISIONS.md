# Décisions de conception

Ce qui a été tranché, et pourquoi. Une session future qui ignore ces règles
réintroduira des bugs déjà corrigés.

---

## L'API est seule source de vérité pour les quantités

Une livraison n'écrase **jamais** un stock. Elle crée un *ajustement* qui se
superpose au dernier relevé, et devient caduc dès que l'API confirme.

C'est ce qui évite le problème du montage d'origine, où le scraper et les
missions écrivaient dans les mêmes cellules. Si un pilote se trompe, le
relevé suivant corrige tout seul.

## Horodatages à la milliseconde

Le stock effectif ne retient que les ajustements **postérieurs** au dernier
relevé. À la seconde près, une livraison tombant dans la même seconde qu'une
synchronisation disparaissait.

Le relevé est daté **avant** l'appel réseau : dater après invaliderait les
livraisons faites pendant que darkstat répond.

## Les missions visent un objectif, pas un seuil d'alerte

| Sens | Objectif | Ouverte tant que | Quantité |
|---|---|---|---|
| Import | Plafond | stock < plafond | plafond − stock |
| Export | Plancher | stock > plancher | stock − plancher |
| Les deux | — | < plancher, ou > plafond | ramène au plafond |

Le seuil opposé marque l'**urgence**, pas le déclenchement.

**Garde-fou :** un plafond > 5 000 000 est ignoré. En jeu, 999 999 999 sert
à laisser vendre sans butoir et n'exprime aucun besoin.

## Les réglages manuels survivent aux relevés

`stock_thresholds` est une table distincte de `stock_snapshots`, que la
synchronisation réécrit intégralement. Y stocker les seuils réglés les
ferait effacer toutes les dix minutes.

Même principe pour les routes : `routes.auto = 1` est recalculé et purgé à
chaque analyse, `auto = 0` n'est jamais touché.

## Les points sont figés à la livraison

`points = quantité × volume × prime_mission × prime_marchandise`, calculé et
**stocké** au moment de la livraison.

Recalculer à l'affichage ferait bouger le classement d'août quand un volume
change en septembre. La répartition mensuelle des gains l'interdit.

## Classement au mois civil

Pas de fenêtre glissante : la paye se fait le 1er du mois sur l'activité du
mois écoulé. Une fenêtre de 30 jours ferait sortir des runs non encore payés.

## Migrations : ne jamais retoucher un fichier déployé

Une migration déjà appliquée est enregistrée dans `schema_migrations` et ne
rejouera pas. La modifier n'a aucun effet en production tout en changeant
les installations neuves — les deux divergent.

**C'est arrivé** : une colonne `margin` ajoutée à `009` après déploiement a
fait échouer l'analyse des routes sur « no column named margin ». Correction
par une migration `010`.

Le lanceur refuse désormais deux fichiers de même numéro.

## Tout ce qui vit sous `/api` répond en JSON

Y compris les erreurs d'authentification (401) et les routes inconnues (404).
Ne jamais rediriger : `fetch()` suivrait la redirection et recevrait du HTML,
sans moyen de distinguer une session expirée d'un proxy mal configuré.

## L'attribut `hidden` doit l'emporter

`[hidden] { display: none !important; }` en tête du CSS. Sans cette règle,
toute déclaration d'auteur posant un `display` neutralise le masquage — ce
qui a laissé l'écran d'amorçage recouvrir une application qui fonctionnait.

## Anglais par défaut

`public/js/i18n.js`, dictionnaire `en` puis `fr`. L'anglais s'applique même à
un navigateur français : l'escadrille est internationale.

**La console de gestion n'est pas encore traduite.** Le mécanisme est en
place, il reste à étendre le dictionnaire.

## La distance se mesure, elle ne s'approxime pas

Le plan initial classait `/api/systems` → `galaxy_pos` en premier et
`/api/graph/paths` en second, au motif que le second coûtait « un POST par
couple de bases ».

**La prémisse était fausse.** `/api/graph/paths` prend un TABLEAU de
couples : 400 couples partent en un appel et reviennent en 150 ms. Les
temps de vol réels coûtent donc *moins* que l'approximation euclidienne,
qui exigeait de télécharger les 22,5 Mo de `/api/systems`.

On mesure donc, et `galaxy_pos` reste inutilisé. Voir `docs/API-DARKSTAT.md`
pour les trois mensonges du swagger sur cet endpoint.

## Les circuits se classent au temps, pas à la marge

`points ÷ seconde`, jamais la marge brute. Un pilote arbitre sur le temps
qu'il y passe.

C'est ce qui rend inutile toute règle interdisant de changer de région : un
circuit qui traverse la galaxie pour trois points s'élimine de lui-même. On
n'a donc **aucun garde-fou géographique**, et il ne faut pas en ajouter —
ce serait écarter les longs trajets qui valent réellement le détour.

**Conséquence à connaître :** les points valent `quantité × volume × primes`
et ne dépendent pas du prix. Le prix ne joue donc sur aucun classement. Il
reste affiché parce qu'il touche la bourse du pilote, jamais sa paye.

## La cale appartient au pilote, pas à la station

Une capacité fixée par station serait fausse pour quiconque ne vole pas le
vaisseau supposé : un même pilote alterne transport et cargo d'un vol à
l'autre. Il la déclare une fois, elle vit sur son profil (`users.cargo_capacity`,
`users.ship_class`).

D'où la règle : **`trade_loops` ne stocke ni quantités ni points.** Ils
dépendent de qui regarde. Seules la topologie du circuit et son économie
unitaire sont figées par le calcul horaire ; `src/services/loops.js` refait
les chiffres à la lecture. Les stocker aurait imposé une cale unique à toute
l'escadrille.

Les temps de trajet ne sont pas recopiés non plus : ils vivent dans
`path_times`, relus par jointure. Les dupliquer aurait obligé à choisir un
type de vaisseau au moment du calcul, alors que le pilote choisit le sien à
la lecture.

## Routes et boucles dans une seule passe

Les deux lisent le même marché à la même cadence. Les faire tourner
séparément doublait les appels à darkstat pour un résultat identique.

La passe vit dans `src/sync/analyse.js`, distincte des deux modules qu'elle
enchaîne : `loops.js` lit déjà le marché via `routes.js`, et loger
l'ordonnancement dans l'un ou l'autre formait un cycle d'imports.

## `api_name` et `api_nickname` ne sont pas interchangeables

Le rapprochement des stocks tolère l'un ou l'autre. `/api/graph/paths`
n'accepte que le **nickname** : « Kadesh Orbital City » y est refusé,
`kadesh_orbital_city` passe.

`stations.api_nickname` est donc renseigné au relevé de stock et tenu
aligné sur l'API. Contrairement au système, ce n'est pas un champ qu'un
officier corrige. Une station sans nickname n'entre dans aucun circuit.

## `path_times` retient aussi les échecs

Environ 12 % des bases PNJ sont absentes du graphe de darkstat — croiseurs
de bataille, « Base Placeholder », bases non amarrables. Les redemander à
chaque passe serait perdu d'avance : `reachable = 0` les marque.

En revanche, une **absence de réponse** n'est jamais mise en cache. Elle
peut venir d'un appel échoué, et la retenir condamnerait des bases valides
sur une simple panne réseau.

## Aucun `db.prepare` au niveau module

`server.js` appelle `migrate()` dans son corps, mais **les imports ESM sont
tous évalués avant**. Une requête préparée au chargement d'un module
s'exécute donc contre le schéma d'AVANT la migration.

Sur une base neuve, rien ne se voit. Sur une base déjà déployée, le serveur
meurt sur « no such table » **sans jamais atteindre la migration censée
créer la table** — une panne dont on ne sort pas en redémarrant.

**C'est arrivé** avec `path_times` et `trade_loops` en 011. Les requêtes y
sont désormais préparées à la première utilisation. C'est la règle partout :
`stock.js`, `missions.js` et `routes.js` préparent tous à l'intérieur des
fonctions.

## SQLite ne lie pas les booléens

`better-sqlite3` refuse `true` / `false` en paramètre, au même titre que
node:sqlite. Un booléen doit devenir `1` / `0` avant d'atteindre la base.

**C'est arrivé** sur `path_times.reachable`, écrit directement depuis
l'objet rendu à l'appelant. La conversion se fait maintenant au moment de
l'écriture, et la valeur reste un booléen côté JavaScript.

## Un run se corrige, il ne s'efface pas

Un pilote peut saisir n'importe quoi — un tonnage à cinq chiffres sur une
mission qui en demande cent. Le stock effectif et le classement du mois
restent faux tant que personne ne peut y toucher, et le pilote concerné ne
voit que ses propres runs.

**Gestion → Runs** donne donc à l'officier la vue et le geste qui lui
manquaient, sur les runs de tous les pilotes :

| État du run | Effet du retrait |
|---|---|
| `in_progress` | Désengagement. Le tonnage réservé repart au pot commun. |
| `delivered` | Annulation : `stock_adjustments` supprimé, `points` à zéro. |

Dans les deux cas la ligne **reste** dans l'historique du pilote, marquée
`abandoned` ou `cancelled`, avec `cancelled_by` et `cancel_reason`. Un run
qui disparaîtrait sans trace ressemblerait à un bug, et priverait l'officier
suivant du seul élément qui explique le geste.

## Le tonnage engagé part de 0

Le champ « tonnage que vous vous engagez à transporter » était pré-rempli
avec le besoin entier de la mission. Un pilote qui validait sans lire
réservait toute la mission et la bloquait pour les autres, puisqu'on ne peut
plus s'engager au-delà du besoin restant.

Il part maintenant de 0 et refuse d'être validé à 0 : c'est au pilote de
dire ce qu'il emporte. Le plafond, lui, reste ce qui manque.
