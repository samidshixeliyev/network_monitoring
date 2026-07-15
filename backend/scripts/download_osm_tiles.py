"""
Download OpenStreetMap raster tiles for a bounding box, zoom z0–z9, into
backend/tiles/osm/{z}/{x}/{y}.png — so the map basemap works FULLY OFFLINE
(air-gapped intranet). Run this ONCE on an internet-connected machine, then ship
the backend/tiles/ folder to the offline server.

Defaults cover Azerbaijan. Override via env or args:
    python scripts/download_osm_tiles.py
    MIN_ZOOM=0 MAX_ZOOM=9 python scripts/download_osm_tiles.py
    python scripts/download_osm_tiles.py --bbox 44.5,38.0,50.6,42.0

Tile source defaults to CARTO's free OSM-based basemap (tile.openstreetmap.org
serves an "Access blocked" tile with HTTP 200 for bulk/script downloads, so it
cannot be trusted here); for heavier use point TILE_SERVER at your own /
licensed tile server. Attribution: © OpenStreetMap contributors © CARTO.
"""
import argparse
import hashlib
import math
import os
import sys
import time
import urllib.request

# Azerbaijan bbox: west, south, east, north (lon/lat degrees).
DEFAULT_BBOX = (44.5, 38.0, 50.6, 42.0)
MIN_ZOOM = int(os.getenv("MIN_ZOOM", "0"))
MAX_ZOOM = int(os.getenv("MAX_ZOOM", "9"))
# voyager_nolabels: place names come from our own Azerbaijani label layer
# (frontend/src/assets/az_places.json via scripts/download_place_labels.py),
# not baked into the raster — the labelled styles are English-only.
TILE_SERVER = os.getenv("TILE_SERVER", "https://basemaps.cartocdn.com/rastertiles/voyager_nolabels")
USER_AGENT = os.getenv(
    "TILE_USER_AGENT",
    "network-monitoring-offline-tiles/1.0 (one-time bbox prefetch; contact: aliagha.huseynli@gmail.com)",
)
# Parallel fetches. Deep zooms (z12/z13) are tens of thousands of tiles; a serial
# 0.1s-polite loop would take hours, so fan out across a small thread pool. Keep
# it modest to stay a good CDN citizen.
CONCURRENCY = int(os.getenv("CONCURRENCY", "8"))

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(_HERE, os.pardir, "tiles", "osm")


def deg2num(lat: float, lon: float, z: int) -> tuple[int, int]:
    lat_r = math.radians(lat)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def _fetch(task: tuple) -> tuple:
    z, x, y, dest, url = task
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        return (z, x, y, True, hashlib.sha256(data).hexdigest(), None)
    except Exception as exc:  # noqa: BLE001
        return (z, x, y, False, None, str(exc))


def download(bbox: tuple[float, float, float, float]) -> None:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    west, south, east, north = bbox
    # Build the work list first (skipping already-cached tiles so re-runs are cheap).
    tasks: list[tuple] = []
    skipped = 0
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x0, y0 = deg2num(north, west, z)   # top-left
        x1, y1 = deg2num(south, east, z)   # bottom-right
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                dest = os.path.join(OUT_DIR, str(z), str(x), f"{y}.png")
                if os.path.exists(dest):
                    skipped += 1
                    continue
                tasks.append((z, x, y, dest, f"{TILE_SERVER}/{z}/{x}/{y}.png"))

    print(f"To fetch: {len(tasks)} tiles ({skipped} already cached), concurrency={CONCURRENCY}")
    downloaded = failed = 0
    per_zoom: dict[int, int] = {}
    # Guard against servers that answer HTTP 200 with an identical "access blocked"
    # tile for every request: if the first several successes are byte-identical, abort.
    seen_hashes: set[str] = set()
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = [ex.submit(_fetch, t) for t in tasks]
        for i, fut in enumerate(as_completed(futs), 1):
            z, x, y, ok, h, err = fut.result()
            if ok:
                downloaded += 1
                seen_hashes.add(h)
                per_zoom[z] = per_zoom.get(z, 0) + 1
                if downloaded >= 8 and len(seen_hashes) == 1:
                    ex.shutdown(wait=False, cancel_futures=True)
                    sys.exit(
                        f"ABORT: first {downloaded} tiles are byte-identical — "
                        f"{TILE_SERVER} is serving an error/blocked tile. Try another TILE_SERVER."
                    )
            else:
                failed += 1
                if failed <= 20:
                    print(f"  FAIL z{z}/{x}/{y}: {err}")
            if i % 1000 == 0:
                print(f"  {i}/{len(tasks)} ({downloaded} ok, {failed} failed)")

    print(f"\nTotal fetched={downloaded} failed={failed} skipped={skipped} -> {os.path.abspath(OUT_DIR)}")
    for z in sorted(per_zoom):
        print(f"  z{z}: {per_zoom[z]} new")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", help="west,south,east,north (lon/lat)", default=None)
    args = ap.parse_args()
    bbox = DEFAULT_BBOX
    if args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(","))  # type: ignore[assignment]
    print(f"Downloading OSM tiles z{MIN_ZOOM}-z{MAX_ZOOM} for bbox {bbox} from {TILE_SERVER}")
    download(bbox)
