import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { Marker, useMap, useMapEvents } from 'react-leaflet'
import azPlaces from '../assets/az_places.json'

// Azerbaijani settlement labels rendered as our own layer on top of the
// label-free basemap (rastertiles/voyager_nolabels). The data comes from OSM
// (backend/scripts/download_place_labels.py -> src/assets/az_places.json), so
// names are the local Azerbaijani ones (Bakı, Sumqayıt, Mingəçevir, ...) and we
// control exactly which settlements appear at which zoom.

interface Place {
  n: string // name (Azerbaijani)
  t: 'city' | 'town' | 'suburb' | 'village'
  p: number // population (0 if unknown)
  lat: number
  lon: number
}

const PLACES = azPlaces as Place[]

// Zoom at which each settlement tier starts to show.
const MIN_ZOOM: Record<Place['t'], number> = {
  city: 0,
  town: 8,
  suburb: 10,
  village: 11,
}

const PANE = 'nm-place-labels'

function placeIcon(place: Place) {
  let size = 11
  let weight = 600
  let color = '#334155'
  if (place.t === 'city') {
    size = place.p >= 500_000 ? 15 : 13
    weight = place.p >= 500_000 ? 800 : 700
    color = '#1e293b'
  } else if (place.t === 'suburb' || place.t === 'village') {
    size = 10
    weight = 500
    color = '#475569'
  }
  const html =
    `<div style="font-size:${size}px;font-weight:${weight};color:${color};white-space:nowrap;` +
    `transform:translate(-50%,-50%);width:max-content;` +
    `text-shadow:-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff,1px 1px 0 #fff,0 0 3px #fff;">` +
    `${place.n}</div>`
  // iconSize [0,0] + the CSS translate centers the text on the coordinate.
  return L.divIcon({ html, className: 'nm-place-label', iconSize: [0, 0] })
}

export function PlaceLabels() {
  const map = useMap()
  const [zoom, setZoom] = useState(map.getZoom())
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) })

  // Dedicated pane between the overlay pane (400) and device markers (600) so
  // labels sit above the basemap but never cover device pins or popups.
  useEffect(() => {
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE)
      pane.style.zIndex = '450'
      pane.style.pointerEvents = 'none'
    }
  }, [map])

  const icons = useMemo(() => PLACES.map(placeIcon), [])

  return (
    <>
      {PLACES.map((place, i) =>
        zoom >= MIN_ZOOM[place.t] ? (
          <Marker
            key={`${place.n}-${place.lat}-${place.lon}`}
            position={[place.lat, place.lon]}
            icon={icons[i]}
            pane={PANE}
            interactive={false}
            keyboard={false}
          />
        ) : null,
      )}
    </>
  )
}
