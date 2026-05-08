# ♿ Accessibilité PMR des transports en commun en Île-de-France

Application Streamlit permettant de visualiser l'accessibilité aux personnes à mobilité réduite (PMR) des transports en commun en Île-de-France.

## App
Lien vers l'application Streamlit :  
 **[https://accessibilite-transports-ile-de-france.streamlit.app/](https://accessibilite-transports-ile-de-france.streamlit.app/)** 


## Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Utilisation

Pour lancer l'application en local :

```bash
streamlit run app.py
```

Les données traitées sont incluses dans le repo (voir `data/processed/`).  Pour régénérer les données traitées à partir des fichiers sources bruts, télécharger d'abord les données depuis l'API Île-de-France Mobilités :

```bash
python src/download_data.py
```

Puis lancer le script de préparation :

```bash
python src/prepare_data.py
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
