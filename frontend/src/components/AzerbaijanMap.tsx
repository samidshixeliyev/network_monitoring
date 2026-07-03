import { memo, useEffect, useMemo } from 'react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  MapContainer,
  GeoJSON,
  Marker,
  Tooltip,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import type { GeoJsonObject } from 'geojson'
import azGeo from '../assets/azerbaijan.json'
import type { Device, DeviceStatus } from '../types'
import { deviceGlyphSvg } from '../lib/deviceIcons'

// Offline OSM raster basemap (z0–z9), pre-downloaded into backend/tiles/osm and
// served at /tiles/osm/... — fully offline, no internet tile providers. Override
// the URL via VITE_TILES_URL if serving tiles from elsewhere.
const TILES_URL =
  (import.meta.env.VITE_TILES_URL as string | undefined) ?? '/tiles/osm/{z}/{x}/{y}.png'
// Highest zoom we have tiles for (the prefetch script defaults to z9).
const MAX_TILE_ZOOM = Number(import.meta.env.VITE_TILES_MAX_ZOOM ?? 9)

const STATUS_COLOR: Record<DeviceStatus, string> = {
  online: '#16a34a',
  offline: '#ef4444',
  unknown: '#eab308',
}

const azData = azGeo as unknown as GeoJsonObject

// Build a type-specific, status-colored map pin as a Leaflet divIcon (no image
// assets → offline). A colored circle holds the white device-type glyph.
function deviceDivIcon(device: Device, selected: boolean) {
  const color = STATUS_COLOR[device.current_status]
  const size = selected ? 40 : 32
  const glyph = deviceGlyphSvg(device.device_type, '#fff', Math.round(size * 0.55))
  const crit = device.is_critical
  // Critical devices get a red ring (pulsing when offline) + a ⚠ badge so they
  // stand out for fast reaction.
  const ring = crit
    ? `box-shadow:0 0 0 3px ${color === '#ef4444' ? '#dc2626' : '#f59e0b'}, 0 1px 6px rgba(0,0,0,.5);`
    : 'box-shadow:0 1px 5px rgba(0,0,0,.45);'
  const pulseClass = crit && device.current_status === 'offline' ? ' nm-crit-pulse' : ''
  const badge = crit
    ? `<div style="position:absolute;top:-6px;right:-6px;background:#dc2626;color:#fff;width:15px;height:15px;border-radius:50%;border:1.5px solid #fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;line-height:1;">!</div>`
    : ''
  const html =
    `<div class="nm-pin${pulseClass}" style="position:relative;width:${size}px;height:${size}px;border-radius:50%;` +
    `background:${color};border:${selected ? 3 : 2}px solid #fff;${ring}` +
    `display:flex;align-items:center;justify-content:center;opacity:${device.is_enabled ? 1 : 0.5};">` +
    `${glyph}${badge}</div>`
  return L.divIcon({ html, className: 'nm-device-pin', iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}

// One device pin. Memoized so a WebSocket tick that changes 3 devices only
// re-renders those 3 markers — not all 500. The icon is rebuilt only when a
// field that affects its appearance changes (status/critical/enabled/type/sel).
interface DeviceMarkerProps {
  device: Device
  selected: boolean
  onSelect: (device: Device) => void
}

const DeviceMarker = memo(function DeviceMarker({ device, selected, onSelect }: DeviceMarkerProps) {
  const icon = useMemo(
    () => deviceDivIcon(device, selected),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device.current_status, device.is_critical, device.is_enabled, device.device_type, selected],
  )
  const color = STATUS_COLOR[device.current_status]
  return (
    <Marker
      position={[device.latitude as number, device.longitude as number]}
      icon={icon}
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(device) }}
    >
      <Tooltip direction="top" offset={[0, -18]}>
        <div style={{ fontWeight: 700, fontSize: 12 }}>{device.vendor_name}</div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#475569' }}>
          {device.ip_address}
        </div>
        <div style={{ fontSize: 11, color, fontWeight: 600, textTransform: 'capitalize' }}>
          {device.device_type} · {device.current_status}
        </div>
      </Tooltip>
    </Marker>
  )
})

// Fit the view to the country outline once, and lock panning to its bounds.
function FitAzerbaijan() {
  const map = useMap()
  useEffect(() => {
    const bounds = L.geoJSON(azData).getBounds()
    map.fitBounds(bounds, { padding: [20, 20] })
    map.setMaxBounds(bounds.pad(0.25))
    map.setMinZoom(map.getBoundsZoom(bounds) - 1)
  }, [map])
  return null
}

// While "placing", a map click reports its coordinates back to the caller.
function ClickToPlace({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

interface Props {
  devices: Device[]
  selectedId: string | null
  onSelect: (device: Device) => void
  placing?: boolean
  onMapClick?: (lat: number, lng: number) => void
}

export function AzerbaijanMap({ devices, selectedId, onSelect, placing, onMapClick }: Props) {
  const placed = useMemo(
    () => devices.filter(d => d.latitude != null && d.longitude != null),
    [devices],
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style>{`
        @keyframes nmCritPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
        .nm-crit-pulse { animation: nmCritPulse 0.9s ease-in-out infinite; }
      `}</style>
      <MapContainer
        center={[40.3, 47.7]}
        zoom={7}
        style={{
          width: '100%',
          height: '100%',
          background: '#dbeafe', // "water" behind the land outline
          cursor: placing ? 'crosshair' : undefined,
        }}
        attributionControl
        zoomControl
      >
        <FitAzerbaijan />

        {/* Offline OSM raster basemap (z0–z9). maxNativeZoom caps tile requests
            at what we actually downloaded; Leaflet upscales beyond if needed. */}
        {TILES_URL && (
          <TileLayer
            url={TILES_URL}
            maxNativeZoom={MAX_TILE_ZOOM}
            maxZoom={18}
            attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          />
        )}

        {/* Country / district outline (bundled, fully offline). */}
        <GeoJSON
          data={azData}
          style={{
            color: '#475569',
            weight: 1,
            fillColor: '#f1f5f9',
            fillOpacity: TILES_URL ? 0 : 1,
          }}
        />

        {placing && onMapClick && <ClickToPlace onClick={onMapClick} />}

        {/* Cluster markers so the map stays smooth at 500+ devices: nearby pins
            collapse into a count bubble until you zoom in. */}
        <MarkerClusterGroup chunkedLoading maxClusterRadius={50} disableClusteringAtZoom={11}>
          {placed.map(device => (
            <DeviceMarker
              key={device.id}
              device={device}
              selected={device.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </MarkerClusterGroup>
      </MapContainer>

      {placing && (
        <div
          style={{
            position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
            zIndex: 1000, background: '#1e40af', color: '#fff',
            padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)', pointerEvents: 'none',
          }}
        >
          📍 Cihazı yerləşdirmək üçün xəritəyə klikləyin
        </div>
      )}
    </div>
  )
}
