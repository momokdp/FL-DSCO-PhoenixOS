# API darkstat — schémas vérifiés

Notes établies **par observation directe** des réponses réelles, pas par
lecture de la documentation. Chaque point ci-dessous a coûté un aller-retour :
ne pas les redécouvrir.

Base : `https://darkstat.dd84ai.com`

---

## `/api/pobs` — bases joueur  (GET)

Source des stocks. Le rapprochement avec nos stations se fait sur `name`
**ou** `nickname`, tolérant à la casse et aux espaces multiples.

```json
{ "nickname": "kadesh_orbital_city", "name": "Kadesh Orbital City",
  "system_name": "Omicron Zeta", "faction_name": "Zoners",
  "money": 38604266, "health": 100, "cargospace": 34953,
  "sector_coord": "C-5", "region_name": "NOMAD WORLDS",
  "is_fallback_info": false,
  "shop_items": [ { "quantity": 284, "price": 16000,
                    "min_stock": 500, "max_stock": 500,
                    "nickname": "commodity_ship_part_avionics",
                    "name": "Avionics Systems",
                    "volume": 30, "original_volume": 30 } ] }
```

**Pièges avérés :**

- L'API renvoie **toutes** les bases du jeu. La majorité porte
  `is_fallback_info: true` avec `shop_items: null` — ce sont des coquilles.
  Une simple `Map` laissait une coquille écraser la vraie fiche.
- Des **homonymes** existent : `sparta_base` (vide) coexiste avec
  `sparta_complex` (réelle).
- `volume` est un **flottant 32 bits** : 0,2 arrive en 0.20000000298023224.
- `volume` et `original_volume` ne disent pas la même chose :
  `original_volume` est le volume unitaire du bien, identique partout ;
  `volume` est ce même volume **pour la classe de vaisseau** que la ligne
  désigne dans `ship_class`. Ce n'est pas une affaire de base, comme on l'a
  d'abord cru : Military Salvage vaut 1 en `original_volume`, 0,2 sur un
  chasseur (classes 0, 1, 3, 4) et 0,4 sur un cargo léger (classe 2).
  Pour un volume de **référence** (comparer l'effort d'une marchandise à
  l'autre), c'est `original_volume` qu'il faut lire.
- Une marchandise est donc **répétée** dans `shop_items` : une ligne à
  `ship_class: null`, puis une par classe qui déroge, avec le même stock et
  le même prix. Mesuré le 2026-11-14 : 584 lignes répétées sur 3 431.
  Additionner les `quantity` sans dédoublonner gonfle la soute occupée.
- `original_volume` vaut 0 pour les biens hors commerce : prévoir un repli.
- `shop_items` peut être `null` alors que `shop_items_map` est peuplé.

---

## `/api/commodities` — marché  (POST, pas GET)

C'est un **POST**. Un GET renvoie les prix agrégés mais `market_goods: null`.

Corps, types imposés par `statproto_deprecated.GetCommoditiesInput` :

```json
{ "include_market_goods": true,     // BOOLÉEN, pas la chaîne "true"
  "filter_to_useful": false,        // booléen
  "filter_nicknames": ["commodity_water"] }   // tableau de chaînes
```

Envoyer `"true"` entre guillemets provoque `failed to read body`.

Réponse — noter que les entrées de `market_goods` sont **plates**, sans
objet `base` imbriqué :

```json
{ "nickname": "commodity_corehardware", "name": "APM Advanced Hardware",
  "volume": 1, "price_base": 30,
  "price_best_base_buys_for": 202, "price_best_base_sells_for": 30,
  "proffit_margin": 172,
  "market_goods": [
    { "nickname": "commodity_corehardware",
      "price_base_buys_for": 90,      // ce que la base NOUS PAIE
      "price_base_sells_for": 90,     // ce que la base NOUS RÉCLAME
      "base_sells": false,            // si false, le prix est théorique
      "base_nickname": "br01_01_base", "base_name": "Planet New London",
      "system_name": "New London", "system_nick": "br01",
      "region_name": "BRETONIA", "faction_name": "Bretonia Police",
      "sector_coord": "D-6", "PoB": null,
      "base_pos": { "X": -24488.6, "Y": 0, "Z": 61745.8 } } ] }
```

**Il n'y a ni `price` ni `sell_price` ici.** Les avoir cherchés a produit
des prix faux (« 1 » partout).

`base_sells: false` signifie que la base n'écoule pas la marchandise : son
prix est décoratif, l'offre doit être écartée à l'import.

### En GET : le barème des volumes par classe de vaisseau

Le GET ne rend pas les offres, mais il suffit pour les volumes, et ne pèse
que 200 ko. Une marchandise y figure une fois à `ship_class: null` — son
volume de référence — puis une fois par classe de vaisseau qui l'emporte à
volume réduit :

```json
[ { "nickname": "commodity_iron", "name": "Iron", "volume": 1,   "ship_class": null },
  { "nickname": "commodity_iron", "name": "Iron", "volume": 0.5, "ship_class": 14 } ]
```

Mesuré le 2026-11-14 : 665 lignes pour 504 marchandises, dont 69 ont au
moins une dérogation. Elles se rangent en trois familles :

| Classe | Vaisseaux | Marchandises à volume réduit |
|---|---|---|
| 14 | vaisseaux de minage (Asteroid Miner, dit Hegemon) | minerais, Iron, Water, Scrap Metal… |
| 10 | paquebots | passagers, réfugiés, prisonniers, VIPs |
| 0 à 4 | chasseurs et cargos légers | pilotes capturés, Military Salvage |

`ship_class` se rapproche du champ `class` de `/api/ships`. La **classe 0
existe** : tester la présence, jamais la vérité de la valeur.

---

## `/api/ships` — catalogue des vaisseaux  (GET)

Un tableau de 498 modèles, près d'un mégaoctet. La console n'en garde que :

```json
{ "nickname": "dsy_miner", "name": "Asteroid Miner",
  "type": "capital", "class": 14, "hold_size": 5000 }
```

- `nickname` est la seule clé sûre : plusieurs modèles portent le même `name`.
- `type` (transport, freighter, fighter, gunboat, cruiser, capital) donne
  l'allure de vol ; `class`, un entier, décide des volumes réduits
  ci-dessus. Les deux ne se déduisent pas l'un de l'autre.
- `hold_size` seul ne dit pas ce qu'un vaisseau emporte : l'Hegemon a 5 000
  de soute et charge 10 000 Iron.

---

## `/api/npc_bases` — bases PNJ  (GET)

`market_goods` y est **null** : ce n'est pas la bonne source pour les prix.
Utile pour la géographie : `system_name`, `region_name`, `sector_coord`,
`pos {X,Y,Z}`, `faction_name`, `IsPob`.

---

## `/api/systems` — géographie  (GET)

```json
{ "nickname": "br01", "name": "New London",
  "galaxy_pos": { "X": 2, "Y": 11 },      // case sur la carte galactique
  "region": { "name": "BRETONIA" },
  "Objs": [ … ] }                          // très volumineux
```

`galaxy_pos` donne une distance approchée **sans aucun appel supplémentaire**.
Suffisant pour écarter les boucles absurdes.

**La réponse pèse 22,5 Mo** pour 137 systèmes : `Objs`, `Zones` et
`Jumpholes` représentent la quasi-totalité du volume, alors que seuls
`nickname`, `name`, `galaxy_pos` et `region` servent ici. Les 137 systèmes
portent tous un `galaxy_pos` exploitable (132 positions distinctes — des
systèmes partagent une case). À ne charger qu'une fois, jamais dans une
requête servie à un pilote.

---

## `/api/graph/paths` — temps de trajet  (POST)

Renvoie le temps en **secondes** entre deux objets, pour Transport, Frigate
et Freighter. Mesuré le 2026-08-30 : les trois points ci-dessous corrigent
ce qui était supposé jusqu'ici.

**Le corps est un TABLEAU, et l'appel est groupé.** Ce n'est pas un POST par
couple de bases : 400 couples sont partis en un seul appel, revenus en
150 ms. Le coût réel est celui d'un appel, pas de N.

```json
[ { "from": "li01_01_base", "to": "br01_01_base" },
  { "from": "li01_01_base", "to": "kadesh_orbital_city" } ]
```

Réponse, un objet par couple, dans l'ordre soumis :

```json
[ { "route": { "from": "li01_01_base", "to": "br01_01_base" },
    "time": { "transport": 526, "frigate": 490, "freighter": 490 } },
  { "route": { "from": "li01_01_base", "to": "base_inconnue" },
    "error": "destination is not found" } ]
```

**Pièges avérés :**

- Les définitions s'appellent `appdata.GraphPathReq`, `appdata.GraphPathsResp`
  et `appdata.GraphPathTime`. **`appdata.GraphPath` n'existe pas** — la
  chercher dans le swagger renvoie `undefined`.
- Le swagger affirme qu'une base joueur se désigne par « Name in base64
  encoding ». **C'est faux.** `kadesh_orbital_city` répond ; le base64 de
  « Kadesh Orbital City » répond `destination is not found`. On passe le
  `nickname` tel quel, PoB comme base PNJ.
- **Environ 12 % des bases de `/api/npc_bases` sont absentes du graphe**
  (37 sur 300 testées) : croiseurs de bataille, « Base Placeholder », bases
  non amarrables. Elles renvoient `error` au lieu de `time`. Un couple en
  erreur n'invalide pas le lot — le reste du tableau est exploitable.
- L'échec courant est donc `error: "destination is not found"`, **pas** la
  sentinelle. Aucune sentinelle n'est apparue sur 525 couples.

Destination injoignable → temps = `9223372036854775807` (max int64).
**Cette sentinelle doit être filtrée**, sinon elle domine tous les tris.
Garder le filtre : non observée ne veut pas dire impossible.

```bash
curl -s https://darkstat.dd84ai.com/swagger/doc.json | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(json.dumps(d['definitions']['appdata.GraphPathReq'], indent=2))"
```

---

## Recettes de fabrication — `/api/npc_bases` puis `/api/infocards`  (POST)

Il n'existe pas de point d'entrée « recettes ». Elles se lisent en deux
appels, mesurés le 2026-11-14 : 220 ko puis 2,1 Mo, pour 263 recettes.

**1. La base fictive `crafts`.** darkstat range tout ce qui se fabrique sur
une base joueur comme marchandises d'une base nommée « PoB crafts » :

```json
POST /api/npc_bases
{ "filter_nicknames": ["crafts"], "include_market_goods": true, "filter_to_useful": false }
```

La réponse est un tableau d'une base, dont `market_goods` porte 225 objets :

```json
{ "nickname": "dsy_corona_package", "name": "Core Battleship", "category": "ship",
  "CraftableInfos": [ { "Disco": {
      "FactoryName": "Modular Shipyard",
      "Command": "/craft shipyardassemblybattleships2 2",
      "RequiredLevel": 3, "LoopProduction": false,
      "CookMinutes": 707.5, "TotalVolume": 8490, "Products": null } } ] }
```

Usine, commande, durée, niveau — **mais aucun ingrédient**. `Products` est
null, et le swagger ne prévoit de liste d'ingrédients que pour FLSR.

**2. Les infocards.** Le corps est un **tableau de nicknames** ; les 225
partent en un seul appel. La réponse suit l'ordre soumis. Chaque infocard
est un tableau de lignes, chacune découpée en `phrases` qu'il faut
recoller. Entre « CRAFTING RECIPES: » et « CRAFTING RECIPES FINISHED »,
chaque recette figure deux fois :

```
[RECIPE #1] (translated)
command: /craft h-fuelproduction 1
Factory: H-Fuel Plant
Total recipe time: 15 minutes
Total recipe volume: 1300
* catalyst: Scientists (100 amount)
] consumed: Helium-3 (500 amount, 1000 vol)
# --- Gas Miners Guild (0.85 multiplier)

[recipe] ; ([RECIPE #1] original)
nickname = recipe_h-fuel
craft_type = H-FuelProduction
cooking_rate = 85
reqlevel = 0
loop_production = 1
produced_item = commodity_h_fuel, 1600
produced_item = commodity_water, 75
consumed = commodity_helium3, 500
catalyst = commodity_scientists, 100
affiliation_bonus = gd_gm_grp, 0.85
```

Le bloc d'origine est le seul fiable pour les identifiants ; le bloc
traduit est le seul à nommer l'usine. On lit donc les deux.

**Pièges avérés :**

- Une recette figure dans l'infocard de **chacun de ses produits** : 340
  blocs pour 263 recettes. Dédoublonner sur `nickname`.
- Plusieurs recettes portent le même `infotext` (variante de base et
  variante « perk »). Seul `nickname` est une clé.
- Trois formes d'ingrédient, pas une :
  `consumed = marchandise, quantité` ;
  `consumed_dynamic_alt = quantité, m1, m2, …` — une seule des marchandises,
  à cette quantité ;
  `consumed_dynamic = m1, q1, m2, q2, …` — une seule, chacune à son tarif.
- `catalyst` n'est **pas consommé** : il doit seulement être en base.
- `produced_affiliation = produit, quantité, faction, autre produit, quantité`
  — le produit change selon l'affiliation de la base (Wildcat Gold, ou Gold
  chez BMM).
- `affiliation_bonus = faction, multiplicateur` réduit les matériaux pour
  les bases de cette faction. Avec `restricted = true`, la liste devient
  une liste d'accès : seules ces factions lancent la recette.
- Les lignes arrivent avec un `\r` final, et certaines sont des
  commentaires (`;craft_type = Survey`) : six recettes n'ont ainsi ni
  `craft_type` ni usine nommée.
- La durée d'un lot vaut `Total recipe volume / cooking_rate`, en minutes.

`/api/pobs` donne par ailleurs `level` (niveau du noyau) et
`faction_nickname` : de quoi appliquer bonus, restrictions et niveau requis.
**Les modules construits sur une base ne sont publiés nulle part.**

---

## Endpoints non explorés

`/api/ammos` `/api/counter_measures` `/api/engines` `/api/factions`
`/api/guns` `/api/hashes` `/api/info_query` `/api/mines`
`/api/mining_operations` `/api/missiles` `/api/pobs/bases` `/api/scanners`
`/api/shields` `/api/thrusters` `/api/tractors`

---

## Méthode

Avant d'écrire du code contre un endpoint : **récupérer une réponse réelle**
et la coller ici. Les suppositions sur les noms de champs ont coûté trois
allers-retours en une session.

```bash
curl -s https://darkstat.dd84ai.com/swagger/doc.json | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(json.dumps(d['paths']['/api/CHEMIN'], indent=2))"
```
