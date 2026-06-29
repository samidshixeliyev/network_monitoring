"""
Download OpenStreetMap raster tiles for a bounding box, zoom z0–z9, into
backend/tiles/osm/{z}/{x}/{y}.png — so the map basemap works FULLY OFFLINE
(air-gapped intranet). Run this ONCE on an internet-connected machine, then ship
the backend/tiles/ folder to the offline server.

Defaults cover Azerbaijan. Override via env or args:
    python scripts/download_osm_tiles.py
    MIN_ZOOM=0 MAX_ZOOM=9 python scripts/download_osm_tiles.py
    python scripts/download_osm_tiles.py --bbox 44.5,38.0,50.6,42.0

Tile source defaults to the public OSM server; for heavier use point TILE_SERVER
at your own / licensed tile server (OSM's tile usage policy forbids bulk use).
"""
import argparse
import math
import os
import time
import urllib.request

# Azerbaijan bbox: west, south, east, north (lon/lat degrees).
DEFAULT_BBOX = (44.5, 38.0, 50.6, 42.0)
MIN_ZOOM = int(os.getenv("MIN_ZOOM", "0"))
MAX_ZOOM = int(os.getenv("MAX_ZOOM", "9"))
TILE_SERVER = os.getenv("TILE_SERVER", "https://tile.openstreetmap.org")
USER_AGENT = os.getenv(
    "TILE_USER_AGENT",
    "network-monitoring-offline-tiles/1.0 (one-time bbox prefetch; contact admin)",
)

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(_HERE, os.pardir, "tiles", "osm")


def deg2num(lat: float, lon: float, z: int) -> tuple[int, int]:
    lat_r = math.radians(lat)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def download(bbox: tuple[float, float, float, float]) -> None:
    west, south, east, north = bbox
    total = downloaded = skipped = failed = 0
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x0, y0 = deg2num(north, west, z)   # top-left
        x1, y1 = deg2num(south, east, z)   # bottom-right
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                total += 1
                dest = os.path.join(OUT_DIR, str(z), str(x), f"{y}.png")
                if os.path.exists(dest):
                    skipped += 1
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                url = f"{TILE_SERVER}/{z}/{x}/{y}.png"
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                try:
                    with urllib.request.urlopen(req, timeout=20) as r:
                        data = r.read()
                    with open(dest, "wb") as f:
                        f.write(data)
                    downloaded += 1
                    time.sleep(0.1)  # be polite to the tile server
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    print(f"  FAIL z{z}/{x}/{y}: {exc}")
        print(f"zoom {z}: done ({downloaded} new, {skipped} cached, {failed} failed so far)")
    print(f"\nTotal {total} tiles → {os.path.abspath(OUT_DIR)}")
    print(f"  downloaded={downloaded} skipped={skipped} failed={failed}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", help="west,south,east,north (lon/lat)", default=None)
    args = ap.parse_args()
    bbox = DEFAULT_BBOX
    if args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(","))  # type: ignore[assignment]
    print(f"Downloading OSM tiles z{MIN_ZOOM}-z{MAX_ZOOM} for bbox {bbox} from {TILE_SERVER}")
    download(bbox)
