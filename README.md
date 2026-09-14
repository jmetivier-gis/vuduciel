# Vu du ciel — la France au nadir

Un jeu façon GeoGuessr, mais à la verticale : chaque manche montre une
photographie aérienne au nadir d'un lieu remarquable de France, à vous de
le repérer sur la carte.

**Jouer :** https://jmetivier-gis.github.io/vuduciel/

## Comment ça marche

- Deux cartes [Leaflet](https://leafletjs.com/) cohabitent : le
  visualiseur (l'imagette, en `CRS.Simple` — un plan en pixels, sans
  projection) et la carte de réponse (géographique, fond
  [OpenFreeMap](https://openfreemap.org/) « Positron » via le pont
  [maplibre-gl-leaflet](https://github.com/maplibre/maplibre-gl-leaflet)).
- La liste des lieux vient de [`vuduciel.geojson`](vuduciel.geojson), tirée
  au sort par lots de 5 à chaque partie (`ROUNDS_PER_GAME` dans
  [`app.js`](app.js)).
- Les imagettes ([`tiles/`](tiles)) sont générées à part par
  [`fetch_ortho.py`](fetch_ortho.py) et versionnées telles quelles — le jeu
  ne fait aucun appel réseau vers l'IGN, seulement vers ses propres
  fichiers statiques et vers OpenFreeMap.
- Chaque manche affiche un bouton **Signaler un problème** et **Proposer un
  lieu**, qui ouvrent une [issue GitHub](../../issues) préremplie (lieu
  concerné, coordonnées, voire une entrée GeoJSON prête à coller).

## Lancer en local

Le jeu charge `vuduciel.geojson` via `fetch()`, que les navigateurs
bloquent en ouvrant directement `index.html` (protocole `file://`). Il faut
donc un serveur local :

```bash
python -m http.server
```

puis ouvrir `http://localhost:8000` — **pas** le fichier depuis
l'explorateur.

## Ajouter des lieux

1. Ajouter des points dans [`vuduciel.geojson`](vuduciel.geojson) (via
   QGIS ou à la main), au format :
   ```json
   { "type": "Feature",
     "properties": { "id": <entier unique>, "nom": "…", "emprise": <mètres> },
     "geometry": { "type": "Point", "coordinates": [ <lon>, <lat> ] } }
   ```
   - `emprise` est le côté du carré au sol couvert par l'imagette. Compter
     large pour un ouvrage étendu (un viaduc, par exemple) : le sujet doit
     tenir en entier dans le cadre.
   - Coordonnées en **EPSG:4326 (WGS 84)**, ordre `[lon, lat]` — c'est
     [`fetch_ortho.py`](fetch_ortho.py) qui reprojette vers le Lambert-93
     (EPSG:2154) attendu par le WMS IGN.
   - Vérifier qu'aucun point n'est trop proche d'un autre : si la distance
     est inférieure à la somme des demi-emprises, les imagettes se
     recouvrent et un lieu peut apparaître dans la photo de son voisin.

2. Générer les imagettes manquantes :
   ```bash
   python fetch_ortho.py
   ```
   Le script saute les imagettes déjà présentes (relancer après une
   coupure ne retélécharge donc que ce qui manque), retente trois fois en
   cas d'erreur transitoire du WMS, et termine par un bilan des échecs
   persistants.

   Si `pyproj` échoue avec *« Invalid projection »* ou *« no database
   context specified »*, il ne trouve pas sa base PROJ — fixer
   `PROJ_DATA` vers le dossier `share/proj` de l'environnement Python
   utilisé (par exemple `.../envs/<env>/Library/share/proj` sous conda) le
   résout.

## Crédits

Imagerie aérienne : BD ORTHO® — IGN-F — [Licence ouverte
2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
