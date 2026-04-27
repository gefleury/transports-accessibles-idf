import sys

sys.path.insert(0, "src")

import streamlit as st
import geopandas as gpd
from streamlit_folium import st_folium

from geoplotter import GeoPlotter

ROUTE_TYPE_COLORS = {
    "Bus":       "#888888",
    "CableWay":  "#9B59B6",
    "Funicular": "#E67E22",
    "Rail":      "#2471A3",
    "Subway":    "#E74C3C",
    "Tram":      "#27AE60",
}

DATA_PATH = "data/traces-des-lignes-de-transport-en-commun-idfm.geojson"


@st.cache_data
def load_data() -> gpd.GeoDataFrame:
    return gpd.read_file(DATA_PATH)


def main():
    st.set_page_config(page_title="Transports Île-de-France", layout="wide")
    st.title("Transports en commun — Île-de-France")

    gdf = load_data()

    # ── Sidebar ──────────────────────────────────────────────────────────────
    st.sidebar.header("Filtres")

    # Route type — Bus unchecked by default (1800+ lines slow to render)
    st.sidebar.subheader("Type de ligne")
    selected_types = [
        rt for rt in ROUTE_TYPE_COLORS
        if st.sidebar.checkbox(rt, value=(rt != "Bus"))
    ]

    gdf_filtered = (
        gdf[gdf["route_type"].isin(selected_types)]
        if selected_types
        else gdf.iloc[:0]
    )

    # Line selector — options update based on selected types
    st.sidebar.subheader("Numéro de ligne")
    available_lines = sorted(gdf_filtered["route_short_name"].dropna().unique())
    selected_lines = st.sidebar.multiselect(
        "Sélectionner des lignes (vide = toutes)",
        options=available_lines,
    )
    if selected_lines:
        gdf_filtered = gdf_filtered[gdf_filtered["route_short_name"].isin(selected_lines)]

    if "Bus" in selected_types and not selected_lines:
        st.sidebar.warning("Afficher toutes les lignes de bus peut être lent.")

    # ── Map ───────────────────────────────────────────────────────────────────
    st.caption(f"{len(gdf_filtered)} tracé(s) affiché(s)")

    if gdf_filtered.empty:
        st.info("Sélectionnez au moins un type de ligne dans le panneau latéral.")
    else:
        geoplotter = GeoPlotter(gdf_filtered, geom_col="geometry", zoom_start=10)
        geoplotter.add_geodata_to_map(
            color_col="route_type",
            colormap=ROUTE_TYPE_COLORS,
            tooltip_cols=["route_short_name", "route_long_name", "route_type", "operatorname"],
        )
        st_folium(geoplotter.map, use_container_width=True, height=700, returned_objects=[])


if __name__ == "__main__":
    main()
