# Chantier en cours

## Boucles de trade — en place

Un pilote ne veut pas rentrer à vide. L'écran « Boucles » propose des
circuits complets, classés au temps de vol réel.

### Ce qui a été construit

| Fichier | Rôle |
|---|---|
| `011-boucles-de-trade.sql` | `trade_loops`, `path_times`, cale du pilote, `stations.api_nickname` |
| `src/sync/paths.js` | Client `/api/graph/paths` groupé, avec cache durable |
| `src/sync/loops.js` | Assemblage et classement des circuits |
| `src/sync/analyse.js` | Passe horaire : routes puis boucles, sur un seul relevé de marché |
| `src/services/loops.js` | Mise à l'échelle du vaisseau du pilote, à la lecture |
| `loopsView` | L'écran, en anglais et en français |

Un circuit reste la forme prévue :

```
Base A  --(marchandise attendue)-->  Notre station S
S       --(marchandise produite)-->  Base B
B       --(retour)--------------->   A
```

Il naît de l'assemblage de **deux missions ouvertes sur la même station** :
une d'import, une d'export. Sans les deux, pas de circuit.

Quatre points étaient laissés à trancher ; ils le sont, et le pourquoi est
consigné dans `docs/DECISIONS.md` :

- **Distance** — temps de vol réels (`/api/graph/paths`), pas `galaxy_pos`.
  L'appel est groupé, donc moins cher que l'approximation.
- **Cale** — déclarée par le pilote, retenue sur son profil.
- **Portée** — la traversée des régions est permise ; le tri au temps
  écarte de lui-même ce qui n'en vaut pas la peine.
- **Cadence** — calcul horaire, dans la même passe que les routes.

### Limites connues

- **Les candidats sont choisis au prix, puis reclassés au temps.** On
  retient les `LOOPS_OFFERS_PER_MISSION` offres les moins chères, et la
  distance ne départage qu'ensuite. Une base proche mais septième au prix
  n'est donc jamais vue. Monter le réglage élargit la fenêtre, au prix de
  plus de couples à mesurer.
- **Une station sans `api_nickname` n'apparaît dans aucun circuit.** Le
  nickname est renseigné au relevé de stock : `npm run sync:now` suffit.
- **`galaxy_pos` reste inexploité.** Il n'a plus d'emploi tant que
  `/api/graph/paths` répond, mais reste le repli si cet endpoint disparaît.

### Pour peupler tout de suite

La passe automatique est horaire et différée de deux minutes au démarrage.

```bash
npm run analyse:now
```

## Reste par ailleurs

- Traduire la console de gestion (mécanisme en place, dictionnaire à étendre).
- Interface de gestion des factions interdites : endpoints en place
  (`/api/admin/factions/blocked`), écran absent.
- Notification Discord à l'ouverture d'une mission critique.
- Historique de stock dans la durée, pour repérer ce qui se vide vite.
- **Débordement horizontal sur mobile.** À 375 px de large, la coque
  déborde (484 px avant les boucles, 459 px après) : la barre supérieure
  et le rail de navigation ne tiennent pas. Antérieur aux boucles, et
  indépendant d'elles.

## Pistes pour les boucles

- Enchaîner les circuits entre eux, pour une soirée entière plutôt qu'un vol.
- Tenir compte du stock réel de la base fournisseuse : `quantite` est déjà
  normalisée dans les offres, mais n'entre pas encore dans le calcul.
- Choisir les candidats sur une combinaison prix / distance plutôt que sur
  le prix seul, ce qui lèverait la première limite ci-dessus.
