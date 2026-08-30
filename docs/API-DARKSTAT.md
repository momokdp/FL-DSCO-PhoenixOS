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
                    "name": "Avionics Systems", "volume": 30 } ] }
```

**Pièges avérés :**

- L'API renvoie **toutes** les bases du jeu. La majorité porte
  `is_fallback_info: true` avec `shop_items: null` — ce sont des coquilles.
  Une simple `Map` laissait une coquille écraser la vraie fiche.
- Des **homonymes** existent : `sparta_base` (vide) coexiste avec
  `sparta_complex` (réelle).
- `volume` est un **flottant 32 bits** : 0,2 arrive en 0.20000000298023224.
- Certaines marchandises ont des variantes suffixées `()`
  (« Military Salvage () ») portant des volumes différents. La variante
  **sans** parenthèses fait autorité.
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

---

## `/api/graph/paths` — temps de trajet  (POST)

Renvoie le temps en **secondes** entre deux objets, pour Transport, Frigate
et Freighter. Corps : un tableau de `appdata.GraphPath` — définition à
récupérer avant usage :

```bash
curl -s https://darkstat.dd84ai.com/swagger/doc.json | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(json.dumps(d['definitions']['appdata.GraphPath'], indent=2))"
```

Destination injoignable → temps = `9223372036854775807` (max int64).
**Ce sentinelle doit être filtrée**, sinon elle domine tous les tris.

---

## Endpoints non explorés

`/api/ammos` `/api/counter_measures` `/api/engines` `/api/factions`
`/api/guns` `/api/hashes` `/api/info_query` `/api/infocards` `/api/mines`
`/api/mining_operations` `/api/missiles` `/api/pobs/bases` `/api/scanners`
`/api/shields` `/api/ships` `/api/thrusters` `/api/tractors`

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
