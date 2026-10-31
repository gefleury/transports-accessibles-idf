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
  style.css, *.js        édités directement, pas de build
  _pages/, _partials/    source des pages HTML (gabarits + en-tête/pied partagés)
  *.html                 généré par build_site.py (gitignored)
  data/                  généré par build_tiles.py (gitignored)

tests/                Tests pytest (pipeline de données + tests dans le navigateur : filtres, popup)

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
| **HTML/CSS/JS "vanilla"** (pas de framework, un script de gabarit minimal) | `style.css` et les scripts `*.js` restent de simples fichiers édités directement. Pour le HTML, `build_site.py` (script Python, sans dépendance) assemble les pages depuis un en-tête/pied de page partagés, pour éviter de dupliquer ce bloc dans chaque fichier — sans introduire de framework ni d'outillage JS. |
| **GitHub Pages + GitHub Actions** | Hébergement statique gratuit, qui suffit puisqu'il n'y a pas de backend. GitHub Actions fournit à la fois le déclenchement planifié (cron hebdomadaire) et le déploiement, sans service tiers. |

## À savoir avant de modifier le code

- **L'accessibilité se définit par couple (arrêt, ligne), pas par arrêt** : Châtelet est inaccessible sur la ligne 11 mais accessible sur la 14. Un même arrêt apparaît donc une fois par ligne qui le dessert.
- **Une partie de l'accessibilité vient de règles écrites à la main**, faute de données IDFM : métro (ligne 14, certaines stations de la ligne 11), tramways (tous accessibles sauf le T14), CDG VAL et Orlyval, etc. Elles sont dans `prepare_data.py` ; un test signale toute nouvelle ligne de métro que ces règles ne connaissent pas.
- **Deux fichiers, deux rôles** : `transports.pmtiles` dessine la carte, `lines.json` alimente le panneau de filtres. Ils sont produits ensemble par `build_tiles.py` et doivent rester cohérents.
- **Règle de performance de la carte** : la mise en évidence d'une sélection n'utilise que le « feature-state » et des styles fixes, jamais de filtres ni de styles dépendant des données, qui font retraiter toutes les tuiles (la carte rame et clignote). Un test le vérifie.
- **Pas de modules JavaScript** : les scripts de `site/` partagent l'espace global de la page et se chargent dans un ordre fixe ; l'en-tête de chaque fichier liste ce qu'il utilise des autres.
- **Dépendances externes** : le fond de carte (OpenFreeMap) et les bibliothèques (unpkg) sont chargés depuis des serveurs tiers ; s'ils sont indisponibles, la carte l'est aussi, indépendamment de notre déploiement.

Le notebook `notebooks/explore_data.ipynb` (avec son utilitaire `geoplotter.py`) sert uniquement à l'exploration ponctuelle des données brutes ; il ne fait pas partie du pipeline de production.
