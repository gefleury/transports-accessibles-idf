# ♿ Accessibilité PMR des transports en commun en Île-de-France

Application permettant de visualiser sur une carte l'accessibilité aux personnes à mobilité réduite (PMR) des transports en commun en Île-de-France. L'objectif est de proposer une vue d'ensemble de l'accessibilité du réseau et d'offrir la possibilité d'afficher uniquement les lignes ayant des arrêts accessibles en toute autonomie.

## App

**[https://gefleury.github.io/transports-accessibles-idf/](https://gefleury.github.io/transports-accessibles-idf/)**

Site statique (MapLibre + PMTiles), sans backend ni base de données, mis à jour automatiquement chaque semaine.

## Branches

- **`main`** — production. Déployée automatiquement sur GitHub Pages via GitHub Actions (voir `.github/workflows/build-deploy.yml`) : téléchargement des données → traitement → tests → déploiement, chaque semaine et à chaque push.
- **`dev`** — développement en cours ; fusionnée dans `main` une fois les changements validés.
- **`streamlit-app`** — ancien prototype [Streamlit](https://accessibilite-transports-ile-de-france.streamlit.app/), archivé.

## Développement

Le développement se fait sur `dev`.

Créer l'environnement virtuel et installer les dépendances :

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip  # --group nécessite pip >= 25.1
pip install --group dev
```

Télécharger les données, les préparer, puis générer les "tuiles" du site :

```bash
python src/download_data.py
python src/prepare_data.py
python src/build_tiles.py   # nécessite tippecanoe
```

Puis lancer le site en local :

```bash
cd site && python -m RangeHTTPServer 8123
```

Et ouvrir http://localhost:8123 

## Sources des données

Données fournies par [Île-de-France Mobilités](https://data.iledefrance-mobilites.fr) en open data ([licences](https://data.iledefrance-mobilites.fr/pages/licences/)):

- [Tracés des lignes](https://data.iledefrance-mobilites.fr/explore/dataset/traces-des-lignes-de-transport-en-commun-idfm/information/)
- [Arrêts des lignes](https://data.iledefrance-mobilites.fr/explore/dataset/arrets-lignes/information)
- [Accessibilité en gare](https://data.iledefrance-mobilites.fr/explore/dataset/accessibilite-en-gare/information/)
- [Accessibilité des arrêts bus](https://data.iledefrance-mobilites.fr/explore/dataset/sdap-arrets-associes/information/)

## Licence

Le code de ce dépôt est distribué sous licence [MIT](LICENSE).

Note : les données sources restent soumises à leurs licences respectives (ODbL et Licence Ouverte Etalab), indépendamment de la licence du code.

## 🤖 Assistance IA

Ce projet a été co-développé avec [Claude Code](https://claude.com/claude-code), l'assistant de programmation d'Anthropic.
