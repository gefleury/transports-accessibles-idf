import sys

sys.path.insert(0, "src")

import geopandas as gpd
import streamlit as st
from streamlit_folium import st_folium

from geoplotter import GeoPlotter

ROUTE_TYPE_COLORS = {
    "Bus": "#888888",
    "CableWay": "#9B59B6",
    "Funicular": "#E67E22",
    "Rail": "#2471A3",
    "Subway": "#E74C3C",
    "Tram": "#27AE60",
}

LINES_PATH = "data/processed/lines.geojson"
STOPS_PATH = "data/processed/stops.geojson"

MAX_STOPS_DEFAULT_ON = 2000


@st.cache_data
def load_data() -> tuple[gpd.GeoDataFrame, gpd.GeoDataFrame]:
    lines = gpd.read_file(LINES_PATH)
    stops = gpd.read_file(STOPS_PATH)
    return lines, stops


def apply_filters(
    gdf: gpd.GeoDataFrame,
    selected_types: list[str],
    selected_lines: list[str],
) -> gpd.GeoDataFrame:
    if not selected_types:
        return gdf.iloc[:0]
    out = gdf[gdf["route_type"].isin(selected_types)]
    if selected_lines:
        out = out[out["route_short_name"].isin(selected_lines)]
    return out


def main():
    st.set_page_config(page_title="Transports Île-de-France", layout="wide")
    st.title("Transports en commun — Île-de-France")
    st.info(
        "Pour de meilleures performances, sélectionnez d'abord un ou plusieurs "
        "numéros de ligne avant d'activer l'affichage des arrêts.",
        icon="💡",
    )

    lines, stops = load_data()

    # ── Sidebar ──────────────────────────────────────────────────────────────
    st.sidebar.header("Filtres")

    # Route type — Bus unchecked by default (1800+ lines slow to render)
    st.sidebar.subheader("Type de ligne")
    selected_types = [
        rt for rt in ROUTE_TYPE_COLORS if st.sidebar.checkbox(rt, value=(rt != "Bus"))
    ]

    lines_filtered = apply_filters(lines, selected_types, [])

    # Line selector — options update based on selected types
    st.sidebar.subheader("Numéro de ligne")
    available_lines = sorted(lines_filtered["route_short_name"].dropna().unique())
    selected_lines = st.sidebar.multiselect(
        "Sélectionner des lignes (vide = toutes)",
        options=available_lines,
    )

    if "Bus" in selected_types and not selected_lines:
        st.sidebar.warning("Afficher toutes les lignes de bus peut être lent.")

    lines_filtered = apply_filters(lines, selected_types, selected_lines)
    stops_filtered = apply_filters(stops, selected_types, selected_lines)

    # Stops toggle — default off when stop count would be too large
    st.sidebar.subheader("Arrêts")
    stops_default = len(stops_filtered) <= MAX_STOPS_DEFAULT_ON
    show_stops = st.sidebar.checkbox("Afficher les arrêts", value=stops_default)
    if not stops_default and show_stops:
        st.sidebar.warning(
            f"{len(stops_filtered)} arrêts à afficher — cela peut être lent. "
            "Sélectionnez des lignes spécifiques pour réduire le nombre d'arrêts."
        )

    # ── Map ───────────────────────────────────────────────────────────────────
    stop_count = len(stops_filtered) if show_stops else 0
    st.caption(f"{len(lines_filtered)} tracé(s) · {stop_count} arrêt(s) affiché(s)")

    if lines_filtered.empty:
        st.info("Sélectionnez au moins un type de ligne dans le panneau latéral.")
    else:
        geoplotter = GeoPlotter(lines_filtered, geom_col="geometry", zoom_start=10)
        geoplotter.add_geodata_to_map(
            color_col="route_type",
            colormap=ROUTE_TYPE_COLORS,
            tooltip_cols=[
                "route_short_name",
                "route_long_name",
                "route_type",
                "operatorname",
            ],
        )
        if show_stops and not stops_filtered.empty:
            geoplotter.add_geodata_from_gdf_to_map(
                stops_filtered,
                geom_col="geometry",
                color_col="route_type",
                colormap=ROUTE_TYPE_COLORS,
                tooltip_cols=["stop_name", "route_short_name", "route_type", "nom_commune"],
                radius=5,
                fill=True,
                fill_opacity=0.8,
                weight=1,
            )
        st_folium(
            geoplotter.map, use_container_width=True, height=700, returned_objects=[]
        )


if __name__ == "__main__":
    main()
