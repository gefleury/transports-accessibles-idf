"""Integration tests for prepare_data.py against the current source CSV files.

These tests:
- Verify that the input files have the columns required by the pipeline. They
  will fail with a clear message if the API delivers files with a different
  structure.
- Assert known accessibility values for specific stops (e.g. Châtelet).

Note: tests are skipped automatically when the data/ directory is absent (e.g.
in CI without the source files). Run them locally after downloading the data.

Run with:
    python -m pytest tests/
    python -m unittest discover tests/
"""

import sys

sys.path.insert(0, "src")

import unittest
from pathlib import Path

import geopandas as gpd
import pandas as pd

from prepare_data import (
    RAW_ACCESSIBILITY_BUS,
    RAW_ACCESSIBILITY_TRAIN,
    RAW_STOPS,
    prepare_accessibility_metro,
)

DATA_AVAILABLE = RAW_STOPS.exists() and RAW_ACCESSIBILITY_BUS.exists() and RAW_ACCESSIBILITY_TRAIN.exists()
skip_if_no_data = unittest.skipUnless(DATA_AVAILABLE, "data/ files not present — skipping integration tests")


@skip_if_no_data
class TestInputFileStructure(unittest.TestCase):
    """Verify input files have the columns expected by the pipeline.

    If any of these tests fail after updating the source files (e.g. from an
    API), it means the pipeline functions need to be updated to match the new
    schema.
    """

    def test_stops_required_columns(self):
        gdf = gpd.read_file(RAW_STOPS)
        required = {"stop_id", "route_long_name", "stop_name", "mode"}
        missing = required - set(gdf.columns)
        self.assertFalse(missing, f"arrets-lignes.geojson is missing columns: {missing}")

    def test_bus_accessibility_required_columns(self):
        df = pd.read_csv(RAW_ACCESSIBILITY_BUS, sep=";")
        required = {"stop_id", "route_long_name", "ArRAccessibility"}
        missing = required - set(df.columns)
        self.assertFalse(missing, f"sdap-arrets-associes.csv is missing columns: {missing}")

    def test_train_accessibility_required_columns(self):
        df = pd.read_csv(RAW_ACCESSIBILITY_TRAIN, sep=";")
        required = {"stop_point_id", "accessibility_level_id"}
        missing = required - set(df.columns)
        self.assertFalse(missing, f"accessibilite-en-gare.csv is missing columns: {missing}")

    def test_bus_accessibility_values_are_valid(self):
        df = pd.read_csv(RAW_ACCESSIBILITY_BUS, sep=";")
        valid = {"true", "false", "partial", "unknown"}
        actual = set(df["ArRAccessibility"].dropna().unique())
        unexpected = actual - valid
        self.assertFalse(unexpected, f"Unexpected ArRAccessibility values in bus file: {unexpected}")

    def test_train_accessibility_level_ids_are_known(self):
        df = pd.read_csv(RAW_ACCESSIBILITY_TRAIN, sep=";")
        known = {1, 3, 4, 6}
        actual = set(df["accessibility_level_id"].dropna().unique())
        unexpected = actual - known
        self.assertFalse(unexpected, f"Unknown accessibility_level_id values in train file: {unexpected}")


@skip_if_no_data
class TestMetroAccessibility(unittest.TestCase):
    """Test prepare_accessibility_metro against the real stops file."""

    @classmethod
    def setUpClass(cls):
        cls.gdf_stops = gpd.read_file(RAW_STOPS)
        cls.result = prepare_accessibility_metro(cls.gdf_stops)

    def _get_accessibility(self, stop_id: str, line: str) -> str | None:
        rows = self.result[
            (self.result["stop_id"] == stop_id) & (self.result["route_long_name"] == line)
        ]
        if rows.empty:
            return None
        return rows["ArRAccessibility"].iloc[0]

    def test_chatelet_line_11_is_inaccessible(self):
        chatelet_11 = self.gdf_stops[
            (self.gdf_stops["mode"] == "Metro")
            & (self.gdf_stops["route_long_name"] == "11")
            & (self.gdf_stops["stop_name"] == "Châtelet")
        ]
        self.assertFalse(chatelet_11.empty, "Châtelet on line 11 not found in input — stop name may have changed")
        for stop_id in chatelet_11["stop_id"].unique():
            self.assertEqual(
                self._get_accessibility(stop_id, "11"),
                "false",
                f"Châtelet (stop_id={stop_id}) on line 11 should be inaccessible",
            )

    def test_chatelet_line_14_is_accessible(self):
        chatelet_14 = self.gdf_stops[
            (self.gdf_stops["mode"] == "Metro")
            & (self.gdf_stops["route_long_name"] == "14")
            & (self.gdf_stops["stop_name"] == "Châtelet")
        ]
        self.assertFalse(chatelet_14.empty, "Châtelet on line 14 not found in input — stop name may have changed")
        for stop_id in chatelet_14["stop_id"].unique():
            self.assertEqual(
                self._get_accessibility(stop_id, "14"),
                "true",
                f"Châtelet (stop_id={stop_id}) on line 14 should be accessible",
            )

    def test_porte_des_lilas_line_11_is_accessible(self):
        pdl = self.gdf_stops[
            (self.gdf_stops["mode"] == "Metro")
            & (self.gdf_stops["route_long_name"] == "11")
            & (self.gdf_stops["stop_name"] == "Porte des Lilas")
        ]
        self.assertFalse(pdl.empty, "Porte des Lilas on line 11 not found — stop name may have changed")
        for stop_id in pdl["stop_id"].unique():
            self.assertEqual(
                self._get_accessibility(stop_id, "11"),
                "true",
                f"Porte des Lilas (stop_id={stop_id}) on line 11 should be accessible",
            )

    def test_output_values_are_valid(self):
        valid = {"true", "false"}
        actual = set(self.result["ArRAccessibility"].unique())
        unexpected = actual - valid
        self.assertFalse(unexpected, f"Unexpected ArRAccessibility values in metro output: {unexpected}")

    def test_output_columns(self):
        for col in ("stop_id", "route_long_name", "ArRAccessibility"):
            self.assertIn(col, self.result.columns)


if __name__ == "__main__":
    unittest.main()
