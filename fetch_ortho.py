"""
Vu du ciel — Génération des imagettes

Récupère une vue aérienne centrée sur un point donné, via le flux WMS
de la Géoplateforme, et l'enregistre en JPEG.

Source : BD ORTHO® - IGN-F - Licence ouverte 2.0
"""

import requests
from pyproj import Transformer
import json
import time

from pathlib import Path

Path("tiles").mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------

WMS_URL = "https://data.geopf.fr/wms-r/wms"
LAYER = "ORTHOIMAGERY.ORTHOPHOTOS"

# Nombre d'essais par imagette avant de déclarer le point en échec.
TENTATIVES = 3

# La BD ORTHO est diffusée en Lambert-93 (EPSG:2154), alors que les points
# de centrage des villes sont en WGS84 (EPSG:4326). Une conversion est donc
# nécessaire avant toute requête.
#
# always_xy=True force l'ordre (longitude, latitude). Sans ce paramètre,
# pyproj respecte l'ordre officiel de l'EPSG:4326, qui est (lat, lon).
# L'oubli ne produit aucune erreur : les images sortent simplement décalées
# de plusieurs centaines de kilomètres.
#
# Le transformateur est créé une seule fois : son initialisation charge la
# base PROJ, coûteuse à répéter sur des centaines d'appels.
TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True)


# ---------------------------------------------------------------------------
# Fonctions
# ---------------------------------------------------------------------------

def fetch_ortho(lon, lat, emprise_m, nom_fichier):
    """Enregistre une imagette aérienne centrée sur un point.

    lon, lat     : coordonnées du centre, en WGS84 (degrés décimaux)
    emprise_m    : côté du carré au sol, en mètres
    nom_fichier  : chemin du JPEG à écrire
    """
    x_l93, y_l93 = TRANSFORMER.transform(lon, lat)

    # Le Lambert-93 étant un système métrique, on additionne directement des
    # mètres aux coordonnées — aucune conversion angulaire nécessaire.
    emprise_demi = emprise_m / 2

    # Le WMS attend un rectangle, pas un point : coin inférieur gauche
    # puis coin supérieur droit, dans l'ordre minx,miny,maxx,maxy.
    min_x = x_l93 - emprise_demi
    min_y = y_l93 - emprise_demi
    max_x = x_l93 + emprise_demi
    max_y = y_l93 + emprise_demi

    bbox = f"{min_x},{min_y},{max_x},{max_y}"

    # Paramètres du standard WMS (OGC). Identiques chez tous les fournisseurs.
    # 2048 px pour 400 m au sol = 19,5 cm/px, soit la résolution native
    # de la BD ORTHO : demander plus fin n'apporterait aucun détail.
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": LAYER,
        "STYLES": "",              # obligatoire, même vide
        "CRS": "EPSG:2154",        # indique au serveur comment lire la bbox
        "BBOX": bbox,
        "WIDTH": 2048,
        "HEIGHT": 2048,
        "FORMAT": "image/jpeg",
    }

    # Le service renvoie par intermittence une erreur sur une requête
    # pourtant valide (un LayerNotDefined sur la couche qui vient de
    # répondre cent fois, par exemple). On réessaie donc avant de conclure
    # à un échec, en espaçant un peu plus à chaque tentative.
    for tentative in range(1, TENTATIVES + 1):
        r = requests.get(WMS_URL, params=params)

        # Un WMS renvoie ses erreurs en XML avec un code HTTP 200. Sans
        # cette vérification, on écrirait un fichier .jpg contenant du XML,
        # et l'erreur ne se manifesterait que bien plus tard.
        if "image" in r.headers["content-type"]:
            break

        if tentative == TENTATIVES:
            raise RuntimeError(f"Réponse non-image du WMS :\n{r.text[:300]}")

        print(f"   tentative {tentative}/{TENTATIVES} échouée, nouvel essai")
        time.sleep(2 * tentative)

    with open(nom_fichier, "wb") as f:
        f.write(r.content)

    print(f"OK — {nom_fichier}")


# ---------------------------------------------------------------------------
# Génération du lot
# ---------------------------------------------------------------------------

with open("vuduciel.geojson", "r", encoding="utf-8") as f:
    donnees = json.load(f)

echecs = []

for feature in donnees["features"]:
    lon, lat = feature["geometry"]["coordinates"]
    site_id = feature["properties"]["id"]
    emprise = feature["properties"]["emprise"]
    nom_fichier = Path("tiles") / f"{site_id}_{emprise}.jpg"

    # Reprise sur incident : sur un lot de plusieurs centaines de points,
    # une coupure réseau en cours de route ne doit pas imposer de tout
    # retélécharger. Supprimer une imagette suffit à la régénérer ; changer
    # l'emprise d'un lieu en produit une nouvelle, sous un autre nom.
    if nom_fichier.exists():
        print(f"— {nom_fichier} (déjà présent)")
        continue

    # Un point définitivement en échec ne doit pas emporter le reste du
    # lot : on le note et on continue. Le bilan final dit quoi relancer,
    # et le test d'existence plus haut fait que relancer le script ne
    # retélécharge que ces points-là.
    try:
        fetch_ortho(lon, lat, emprise, nom_fichier)
    except Exception as erreur:
        print(f"ÉCHEC — {nom_fichier} : {erreur}")
        echecs.append(feature["properties"]["nom"])

    # Le WMS de la Géoplateforme est un service public mutualisé : on
    # espace les requêtes plutôt que de le marteler.
    time.sleep(1)

# ---------------------------------------------------------------------------
# Bilan
# ---------------------------------------------------------------------------

if echecs:
    print(f"\n{len(echecs)} imagette(s) en échec, à relancer :")
    for nom in echecs:
        print(f"   {nom}")
else:
    print("\nToutes les imagettes sont en place.")