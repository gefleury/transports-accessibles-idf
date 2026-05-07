# Accessibilité PMR des transports en commun en Île-de-France

Application Streamlit permettant de visualiser l'accessibilité aux personnes à mobilité réduite (PMR) des transports en commun en Île-de-France.


## Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Utilisation

Placer les fichiers de données brutes dans `data/` (voir sources ci-dessous), puis préparer les données avec:

```bash
python src/prepare_data.py
```

Lancer l'application avec:

```bash
streamlit run app.py
```

## Sources des données

Données fournies par [Île-de-France Mobilités](https://data.iledefrance-mobilites.fr) en open data ([licences](https://data.iledefrance-mobilites.fr/pages/licences/)):

- [Tracés des lignes](https://data.iledefrance-mobilites.fr/explore/dataset/traces-des-lignes-de-transport-en-commun-idfm/information/)
- [Arrêts des lignes](https://data.iledefrance-mobilites.fr/explore/dataset/arrets-lignes/information)
- [Accessibilité en gare](https://data.iledefrance-mobilites.fr/explore/dataset/accessibilite-en-gare/information/)
- [Accessibilité des arrêts bus](https://data.iledefrance-mobilites.fr/explore/dataset/sdap-arrets-associes/information/)

## Licence

Le code de ce dépôt est distribué sous licence [MIT](LICENSE).

Note : les données sources restent soumises à leurs licences respectives (ODbL et Licence Ouverte Etalab), indépendamment de la licence du code.
