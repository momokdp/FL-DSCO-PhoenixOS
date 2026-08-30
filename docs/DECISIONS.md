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
