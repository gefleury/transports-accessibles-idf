"""Tests for build_tiles.py's lines.json content, on synthetic stops.

Run with:
    python -m pytest tests/test_build_tiles.py
"""

import sys

sys.path.insert(0, "src")

from build_tiles import line_cities


def test_line_cities():
    def stop(line, code, name, status):
        return {"id": line, "code_insee": code, "nom_commune": name, "ArRAccessibility": status}

    stops = [
        stop("L1", "94054", "Orly", "true"),
        stop("L1", "94054", "Orly", "true"),
        stop("L1", "94054", "Orly", "false"),
        stop("L1", "94048", "Marolles-en-Brie", "partial"),
        stop("L2", "77278", "Marolles-en-Brie", "unknown"),
    ]
    per_line, labels = line_cities(stops)
    assert per_line == {
        "L1": {"94054": {"true": 2, "false": 1}, "94048": {"partial": 1}},
        "L2": {"77278": {"unknown": 1}},
    }
    # Homonyms told apart by their département.
    assert labels == {
        "94054": "Orly (94)",
        "94048": "Marolles-en-Brie (94)",
        "77278": "Marolles-en-Brie (77)",
    }
