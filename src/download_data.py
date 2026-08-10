"""Download raw source files from the Île-de-France Mobilités open data platform.

Usage:
    python src/download_data.py
"""

import gzip
import urllib.request
from pathlib import Path

GZIP_MAGIC = b"\x1f\x8b"

DATA_DIR = Path("data")
BASE_URL = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets"

DATASETS = [
    (
        "traces-des-lignes-de-transport-en-commun-idfm",
        "geojson",
        DATA_DIR / "traces-des-lignes-de-transport-en-commun-idfm.geojson",
    ),
    (
        "arrets-lignes",
        "geojson",
        DATA_DIR / "arrets-lignes.geojson",
    ),
    (
        "sdap-arrets-associes",
        "csv",
        DATA_DIR / "sdap-arrets-associes.csv",
    ),
    (
        "accessibilite-en-gare",
        "csv",
        DATA_DIR / "accessibilite-en-gare.csv",
    ),
]


def download(url: str, dest: Path) -> None:
    def progress(block_count, block_size, total_size):
        if total_size > 0:
            pct = min(block_count * block_size / total_size * 100, 100)
            print(f"\r  {dest.name} ... {pct:.0f}%", end="", flush=True)

    print(f"  {dest.name} ...", end="", flush=True)
    urllib.request.urlretrieve(url, dest, reporthook=progress)
    # Some IDFM exports come back gzip-compressed even without the client
    # requesting it (observed on arrets-lignes.geojson, not on the others).
    # Detect and decompress from the file's magic bytes rather than trusting
    # response headers, since the actual behavior differs across datasets.
    with dest.open("rb") as f:
        is_gzip = f.read(2) == GZIP_MAGIC
    if is_gzip:
        with gzip.open(dest, "rb") as f:
            data = f.read()
        dest.write_bytes(data)
    print(f"\r  {dest.name} ... OK      ")


def main():
    DATA_DIR.mkdir(exist_ok=True)

    for dataset_id, fmt, dest in DATASETS:
        params = "?delimiter=%3B" if fmt == "csv" else ""
        url = f"{BASE_URL}/{dataset_id}/exports/{fmt}{params}"
        download(url, dest)

    print("Téléchargement terminé. Lancer ensuite : python src/prepare_data.py")


if __name__ == "__main__":
    main()
