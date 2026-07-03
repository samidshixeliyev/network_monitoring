"""
Download Azerbaijan settlement names from OpenStreetMap (Overpass API) into
frontend/src/assets/az_places.json — the map renders these as its own label
layer on top of the label-free basemap, so place names are always in
Azerbaijani (OSM local `name` tags in AZ) and WE decide which settlements
appear. Run ONCE on an internet-connected machine (like the tile prefetch);
the generated asset is bundled and fully offline.

    python scripts/download_place_labels.py

Included: place=city/town (all), place=suburb (Bakı metro settlements),
place=village that carries a population tag (larger villages).
"""
import json
import os
import urllib.parse
import urllib.request

OVERPASS_URL = os.getenv("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
USER_AGENT = "network-monitoring-labels/1.0 (one-time prefetch; contact: aliagha.huseynli@gmail.com)"

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="AZ"][admin_level=2]->.az;
(
  node(area.az)[place~"^(city|town)$"];
  node(area.az)[place="suburb"];
  node(area.az)[place="village"][population];
);
out body;
"""

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.normpath(
    os.path.join(_HERE, os.pardir, os.pardir, "frontend", "src", "assets", "az_places.json")
)


def _population(tags: dict) -> int:
    try:
        return int(str(tags.get("population", "0")).replace(" ", "").replace(",", ""))
    except ValueError:
        return 0


def main() -> None:
    req = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": QUERY}).encode(),
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)

    places = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        # In Azerbaijan the local `name` is Azerbaijani; name:az is a fallback
        # for nodes tagged with a different local language.
        name = tags.get("name:az") or tags.get("name")
        if not name:
            continue
        places.append(
            {
                "n": name,
                "t": tags["place"],
                "p": _population(tags),
                "lat": round(el["lat"], 5),
                "lon": round(el["lon"], 5),
            }
        )

    # Big first so painters/z-order and any truncation favour importance.
    places.sort(key=lambda x: -x["p"])
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(places, f, ensure_ascii=False, separators=(",", ":"))
    counts: dict[str, int] = {}
    for pl in places:
        counts[pl["t"]] = counts.get(pl["t"], 0) + 1
    print(f"{len(places)} places -> {OUT_PATH}")
    print("  " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


if __name__ == "__main__":
    main()
