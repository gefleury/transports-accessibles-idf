# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environment setup

Python 3.12.4 (see `.python-version`). A `.venv` virtualenv is already present at the repo root.

```bash
# Activate the virtualenv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

There is no test suite and no linter configured yet.

## Running notebooks

Notebooks live in `notebooks/`. Run them with VS Code's Jupyter extension or:

```bash
jupyter notebook notebooks/explore_data.ipynb
```

**Notebook trust**: folium maps won't render tiles in VS Code until the notebook is trusted. Use `Ctrl+Shift+P` → `Jupyter: Trust Current Notebook`.

## Architecture

### Data

`data/` is gitignored. The primary dataset is IDF Mobilités public transport lines for Île-de-France, available as both GeoJSON and CSV:
- `traces-des-lignes-de-transport-en-commun-idfm.geojson` — geometry + metadata (used by `GeoPlotter`)
- `traces-des-lignes-de-transport-en-commun-idfm.csv` — tabular version

Key columns: `route_type` (Bus / Subway / Tram / Rail / Funicular / CableWay), `route_color`, `route_short_name`, `route_long_name`, `operatorname`.

### `src/geoplotter.py`

The sole source module. `GeoPlotter` wraps a GeoPandas GeoDataFrame and a Folium map:

- `__init__`: validates/converts CRS to EPSG:4326, computes map centre using Lambert-93 (EPSG:2154) centroids, creates `folium.Map`.
- `add_geodata_to_map`: iterates rows, resolves colour (flat or via `color_col` + `colormap` dict/callable), builds tooltips, dispatches to the appropriate `add_*` method.
- `add_geodata_from_gdf_to_map`: overlays a second GeoDataFrame onto the existing map by temporarily swapping `self.map`.
- Geometry dispatch: `add_geometry_element` routes to `add_linestring / add_multilinestring / add_point / add_multipoint / add_polygon / add_multipolygon / add_geometrycollection`. 3D geometries are flattened to 2D before rendering.

Notebooks import via `sys.path.insert(0, "../src")` then `from geoplotter import GeoPlotter`.
