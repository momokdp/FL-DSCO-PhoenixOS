# Chantier suivant : boucles de trade

## Le besoin

Une suggestion aller simple ne suffit pas : un pilote ne veut pas rentrer à
vide. Il veut un circuit — acheter, livrer, recharger, revendre, boucler.

## Ce qui existe déjà

- Les missions ouvertes, avec leur sens et leur quantité.
- Pour chaque marchandise, la meilleure base à l'achat et à la revente,
  avec faction, système et coordonnées de secteur (`src/sync/routes.js`).
- Le volume unitaire de chaque marchandise, donc la capacité de cale.

## Ce qui manque : la distance

Sans elle, on proposera des circuits traversant la galaxie pour cent
crédits de marge.

Deux sources, par ordre de coût croissant :

1. **`/api/systems` → `galaxy_pos {X, Y}`.** Distance euclidienne sur la
   carte galactique. Un seul appel, mis en cache indéfiniment — la
   géographie ne bouge pas. Approximatif mais suffisant pour écarter
   l'absurde. **À faire en premier.**

2. **`/api/graph/paths`.** Temps réel de trajet en secondes, par type de
   vaisseau. Plus juste, mais un POST par couple de bases. À réserver au
   classement final d'une poignée de candidats.

Récupérer d'abord la définition de `appdata.GraphPath` (voir
`docs/API-DARKSTAT.md`), et **filtrer la sentinelle** `9223372036854775807`
qui signale une destination injoignable.

## Forme proposée

Un circuit à trois segments :

```
Base PNJ A  --(marchandise attendue)-->  Notre station S
Notre station S  --(marchandise produite)-->  Base PNJ B
B  --(retour)-->  A          si B et A sont proches
```

Critère de tri : **points gagnés par unité de temps**, pas marge brute. Un
pilote arbitre sur le temps passé, pas sur le crédit.

## Points à trancher avant de coder

- Capacité de cale : demandée au pilote, ou fixée par station ?
- Un circuit doit-il rester dans une région, ou traverser est-il acceptable ?
- Les boucles sont-elles calculées d'avance (comme les routes, à l'heure)
  ou à la demande du pilote ?

## Reste par ailleurs

- Traduire la console de gestion (mécanisme en place, dictionnaire à étendre).
- Interface de gestion des factions interdites : endpoints en place
  (`/api/admin/factions/blocked`), écran absent.
- Notification Discord à l'ouverture d'une mission critique.
- Historique de stock dans la durée, pour repérer ce qui se vide vite.
