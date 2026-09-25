# Vue d'ensemble

Ce dépôt construit une carte web de l'accessibilité PMR des transports en commun d'Île-de-France, à partir des données open data d'[Île-de-France Mobilités](https://data.iledefrance-mobilites.fr). Le site est statique (aucun serveur applicatif, aucune base de données) et se met à jour automatiquement chaque semaine.

Pour lancer le projet en local : voir [README.md](../README.md). 

## Organisation du dépôt

```
src/                  Pipeline de données (production)
  download_data.py      télécharge les fichiers bruts depuis l'API IDFM
  prepare_data.py         nettoie et joint les données -> data/processed/
  build_tiles.py           génère les tuiles vectorielles -> site/data/
  build_site.py            assemble les pages HTML -> site/*.html

site/                 Frontend statique, servi tel quel par GitHub Pages
  style.css, app.js      édités directement, pas de build
  _pages/, _partials/    source des pages HTML (gabarits + en-tête/pied partagés)
  *.html                 généré par build_site.py (gitignored)
  data/                  généré par build_tiles.py (gitignored)

tests/                Tests pytest (pipeline de données + test d'initialisation du navigateur)

notebooks/            Exploration et débogage ponctuels (hors pipeline)

.github/workflows/    Automatisation CI/CD (voir pipeline.md)

data/                 Données brutes et traitées (gitignored, régénérées localement)
```

## Pourquoi cette architecture

Afficher ~1000 lignes de bus et leurs ~73 000 arrêts avec un rendu fluide impose de précalculer un maximum de choses côté pipeline Python, pour ne laisser au navigateur que du filtrage et du rendu — plus aucun calcul géographique ou traitement de données ne s'y produit.

| Choix | Pourquoi |
|---|---|
| **Pas de base de données** | Les données ne changent qu'une fois par semaine, en lot ; aucune requête n'est imprévisible. Des fichiers statiques précalculés jouent ce rôle sans les coûts et la complexité d'une base. |
| **PMTiles** (tuiles vectorielles dans un seul fichier) | Le GeoJSON complet pèse plus de 100 Mo. PMTiles pré-découpe les géométries par niveau de zoom ; le navigateur ne télécharge, via des requêtes HTTP Range, que le petit fragment correspondant à la zone affichée — sans serveur de tuiles dédié, juste un fichier statique. |
| **tippecanoe** | Outil standard et open source pour construire des tuiles vectorielles à partir de GeoJSON, avec simplification et allègement automatiques par niveau de zoom. Étape d'empaquetage uniquement — il ne remplace pas geopandas, qui reste responsable de tout le nettoyage et des jointures. |
| **MapLibre GL JS** (plutôt que Leaflet) | Leaflet dessine chaque objet en DOM/SVG, ce qui ne passe pas à l'échelle avec ~1000 lignes de bus. MapLibre s'appuie sur le GPU et gère nativement les tuiles vectorielles et PMTiles ; c'est la continuation open source de Mapbox GL JS. |
| **HTML/CSS/JS "vanilla"** (pas de framework, un script de gabarit minimal) | `style.css` et `app.js` restent de simples fichiers édités directement. Pour le HTML, `build_site.py` (script Python, sans dépendance) assemble les pages depuis un en-tête/pied de page partagés, pour éviter de dupliquer ce bloc dans chaque fichier — sans introduire de framework ni d'outillage JS. |
| **GitHub Pages + GitHub Actions** | Hébergement statique gratuit, qui suffit puisqu'il n'y a pas de backend. GitHub Actions fournit à la fois le déclenchement planifié (cron hebdomadaire) et le déploiement, sans service tiers. |

Le notebook `notebooks/explore_data.ipynb` (avec son utilitaire `geoplotter.py`) sert uniquement à l'exploration ponctuelle des données brutes ; il ne fait pas partie du pipeline de production.
