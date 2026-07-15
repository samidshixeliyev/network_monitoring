import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  MapContainer,
  GeoJSON,
  Marker,
  Polygon,
  Polyline,
  Popup,
  Tooltip,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GeoJsonObject } from 'geojson'
import azGeo from '../assets/azerbaijan.json'
import type { Device, DeviceLinkKind, DeviceStatus } from '../types'
import { deviceGlyphSvg } from '../lib/deviceIcons'
import { deviceLinksApi } from '../api/deviceLinks'
import { useAuth } from '../hooks/useAuth'
import { PlaceLabels } from './PlaceLabels'

const MANUAL_LINK_STYLE: Record<DeviceLinkKind, { color: string; dash?: string; az: string }> = {
  physical: { color: '#0d9488', az: 'Fiziki' },
  logical: { color: '#8b5cf6', dash: '6 6', az: 'Məntiqi' },
}

// Offline raster basemap (label-free CARTO style; AZ z0–z11 + world z0–z7),
// pre-downloaded into backend/tiles/osm and served at /tiles/osm/... — fully
// offline, no internet tile providers. Place names are drawn by PlaceLabels
// (Azerbaijani). Override the URL via VITE_TILES_URL if serving from elsewhere.
// ?v=N busts browser caches whenever the tile set is replaced (tiles are
// served without Cache-Control, so browsers hold them indefinitely).
const TILES_URL =
  (import.meta.env.VITE_TILES_URL as string | undefined) ?? '/tiles/osm/{z}/{x}/{y}.png?v=3'
// Highest zoom we have tiles for (backend/tiles/osm is prefetched to this level).
const MAX_TILE_ZOOM = Number(import.meta.env.VITE_TILES_MAX_ZOOM ?? 13)

const STATUS_COLOR: Record<DeviceStatus, string> = {
  online: '#16a34a',
  offline: '#ef4444',
  unknown: '#eab308',
}

const azData = azGeo as unknown as GeoJsonObject

// ── Country mask ──────────────────────────────────────────────────────────────
// Everything OUTSIDE Azerbaijan is painted over so only the country's territory
// shows. Built as one polygon: a world-covering outer ring with each part of the
// AZ border punched out as a hole (even-odd fill). Leaflet wants [lat,lng].
const WORLD_RING: [number, number][] = [
  [-89, -180], [-89, 180], [89, 180], [89, -180],
]

function azBorderRings(): [number, number][][] {
  const rings: [number, number][][] = []
  const addPoly = (coords: number[][][]) => {
    if (coords?.length) rings.push(coords[0].map(([lng, lat]) => [lat, lng] as [number, number]))
  }
  const walk = (g: any) => {
    if (!g) return
    if (g.type === 'FeatureCollection') g.features.forEach((f: any) => walk(f.geometry))
    else if (g.type === 'Feature') walk(g.geometry)
    else if (g.type === 'Polygon') addPoly(g.coordinates)
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(addPoly)
  }
  walk(azData as any)
  return rings
}

const MASK_POSITIONS: [number, number][][] = [WORLD_RING, ...azBorderRings()]

// Paint out everything beyond the border so neighbouring countries / open sea
// don't distract from the AZ view.
function CountryMask() {
  return (
    <Polygon
      positions={MASK_POSITIONS}
      pathOptions={{ stroke: false, fillColor: '#e8eef5', fillOpacity: 1, fillRule: 'evenodd', interactive: false }}
    />
  )
}

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

// Worst-of status for a cluster of co-located devices (offline > unknown > online),
// so a site badge turns red the moment ANY device in it goes down.
function aggregateStatus(devices: Device[]): DeviceStatus {
  if (devices.some(d => d.current_status === 'offline')) return 'offline'
  if (devices.some(d => d.current_status === 'unknown')) return 'unknown'
  return 'online'
}

// A "site" marker for 2+ devices sharing one coordinate — drawn as a SERVER RACK
// CABINET (the real-world thing: several devices stacked in one rack / PoP), not
// a plain count badge. Dark cabinet frame with status-colored trim, a few "U"
// slots, and a corner count of how many devices are inside. Worst-of status
// colors it (red the moment any device drops); click it to expand the list.
function siteDivIcon(devices: Device[], selected: boolean) {
  const color = STATUS_COLOR[aggregateStatus(devices)]
  const n = devices.length
  const w = selected ? 34 : 30
  const h = Math.round(w * 1.3)
  const anyCritDown = devices.some(d => d.is_critical && d.current_status === 'offline')
  // Three "rack unit" slots; the top one glows in the site's status color.
  const slots = [0, 1, 2]
    .map(i => `<rect x="6" y="${12 + i * 6}" width="${w - 12}" height="3.4" rx="1" fill="${i === 0 ? color : '#475569'}"/>`)
    .join('')
  const html =
    `<div class="nm-pin${anyCritDown ? ' nm-crit-pulse' : ''}" style="position:relative;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));">` +
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="4" fill="#1e293b" stroke="${selected ? '#ffffff' : color}" stroke-width="${selected ? 2.5 : 2}"/>` +
    `<rect x="5" y="5" width="${w - 10}" height="3" rx="1" fill="#334155"/>` +
    slots +
    `</svg>` +
    `<div style="position:absolute;bottom:-6px;right:-6px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;` +
    `background:${color};color:#fff;border-radius:8px;border:1.5px solid #fff;` +
    `font:800 11px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;line-height:1;">${n}</div>` +
    `</div>`
  return L.divIcon({ html, className: 'nm-device-pin', iconSize: [w, h], iconAnchor: [w / 2, h / 2] })
}

interface SiteMarkerProps {
  devices: Device[]
  position: [number, number]
  selectedId: string | null
  pendingSource: string | null
  onSelect: (device: Device) => void
}

// Co-located devices collapse into one badge; the Popup is the "expand" — each
// row opens that device (and in connect-mode picks it as source/target, which
// resolves the "which device did I click?" ambiguity a stacked pin can't).
const SiteMarker = memo(function SiteMarker({ devices, position, selectedId, pendingSource, onSelect }: SiteMarkerProps) {
  const highlighted = devices.some(d => d.id === selectedId || d.id === pendingSource)
  const icon = useMemo(
    () => siteDivIcon(devices, highlighted),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [devices.map(d => `${d.id}:${d.current_status}:${d.is_critical}`).join('|'), highlighted],
  )
  const down = devices.filter(d => d.current_status === 'offline').length
  const unknown = devices.filter(d => d.current_status === 'unknown').length
  const online = devices.length - down - unknown
  return (
    <Marker position={position} icon={icon} zIndexOffset={highlighted ? 1000 : 0}>
      <Tooltip direction="top" offset={[0, -22]}>
        <div style={{ fontWeight: 700, fontSize: 12 }}>
          {devices.length} cihaz · {devices[0].location_text || 'eyni nöqtə'}
        </div>
        <div style={{ fontSize: 11, color: '#475569' }}>
          {online > 0 && <span style={{ color: STATUS_COLOR.online }}>{online} online</span>}
          {unknown > 0 && <span style={{ color: STATUS_COLOR.unknown }}>{online > 0 ? ' · ' : ''}{unknown} unknown</span>}
          {down > 0 && <span style={{ color: STATUS_COLOR.offline }}>{online + unknown > 0 ? ' · ' : ''}{down} offline</span>}
        </div>
      </Tooltip>
      <Popup minWidth={220} maxWidth={300}>
        <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
          {devices.length} cihaz · {devices[0].location_text || 'eyni koordinat'}
        </div>
        <div style={{ maxHeight: 230, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {devices.map(d => (
            <button
              key={d.id}
              onClick={() => onSelect(d)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', width: '100%',
                border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                background: d.id === selectedId || d.id === pendingSource ? '#eef2ff' : 'transparent',
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: STATUS_COLOR[d.current_status] }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 12, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.is_enabled ? '' : '⦸ '}{d.vendor_name}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 10.5, color: '#64748b' }}>
                  {d.ip_address} · {d.device_type}
                </span>
              </span>
              {d.is_critical && <span title="kritik" style={{ color: '#dc2626', fontWeight: 800, fontSize: 12 }}>!</span>}
            </button>
          ))}
        </div>
      </Popup>
    </Marker>
  )
})

// Fit so the WHOLE country is visible without cropping its edges ("contain").
// The most zoomed-out state is this full-country view — zooming out further only
// exposes the ugly low world tiles, so it's the floor. Re-fits on resize.
function FitAzerbaijan() {
  const map = useMap()
  useEffect(() => {
    const bounds = L.geoJSON(azData).getBounds()
    const fit = () => {
      // inside=false → largest zoom at which the whole bounds still fit in view,
      // i.e. all of AZ shown, edges intact.
      const containZoom = map.getBoundsZoom(bounds, false)
      map.setView(bounds.getCenter(), containZoom, { animate: false })
      map.setMaxBounds(bounds.pad(0.2))
      map.setMinZoom(containZoom)
    }
    fit()
    map.on('resize', fit)
    return () => { map.off('resize', fit) }
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

  // Group devices sharing a coordinate (~1 m precision). Pixel-based clustering
  // can never separate identical coords no matter the zoom, so co-located devices
  // (a rack / PoP) collapse into ONE clickable "site" badge; lone devices render
  // as normal pins. This keeps overlapping markers clickable and legible.
  const { soloDevices, siteGroups } = useMemo(() => {
    const byCoord = new Map<string, Device[]>()
    for (const d of placed) {
      const key = `${(d.latitude as number).toFixed(5)},${(d.longitude as number).toFixed(5)}`
      const arr = byCoord.get(key)
      if (arr) arr.push(d)
      else byCoord.set(key, [d])
    }
    const solo: Device[] = []
    const sites: { key: string; position: [number, number]; devices: Device[] }[] = []
    byCoord.forEach((group, key) => {
      if (group.length === 1) solo.push(group[0])
      else sites.push({ key, position: [group[0].latitude as number, group[0].longitude as number], devices: group })
    })
    return { soloDevices: solo, siteGroups: sites }
  }, [placed])

  // Topology links: a line from each device to its parent (both must be placed
  // on the map). It's an opt-in overlay layer — HIDDEN by default; the user
  // turns the "🔗 Əlaqələr" layer on to reveal the dependency lines. The choice
  // then persists across sessions.
  const [showLinks, setShowLinks] = useState(
    () => localStorage.getItem('nm.topoLinks') === 'on',
  )
  const toggleLinks = () => {
    setShowLinks(v => {
      localStorage.setItem('nm.topoLinks', v ? 'off' : 'on')
      return !v
    })
  }
  const links = useMemo(() => {
    const byId = new Map(placed.map(d => [d.id, d]))
    return placed
      .filter(d => d.parent_id && byId.has(d.parent_id))
      .map(d => ({ child: d, parent: byId.get(d.parent_id!)! }))
  }, [placed])

  // ── Manual links (physical / logical) drawn straight on the map ─────────────
  const qc = useQueryClient()
  const { hasPermission, isManager } = useAuth()
  const canEdit = hasPermission('edit_device') || isManager
  const { data: deviceLinks = [] } = useQuery({
    queryKey: ['device-links'], queryFn: deviceLinksApi.list, refetchInterval: 60_000,
  })
  const createLinkM = useMutation({
    mutationFn: deviceLinksApi.create,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-links'] }),
  })
  // `mutate` is a stable reference in React Query v5; the mutation OBJECT is not
  // (it's recreated every render). Depending on `mutate` — not `createLinkM` —
  // keeps `handleMarker` stable, so the memoized markers don't ALL re-render on
  // every status tick (which is a new `devices` array → a re-render).
  const createLink = createLinkM.mutate

  const [connectMode, setConnectMode] = useState(false)
  const [linkKind, setLinkKind] = useState<DeviceLinkKind>('physical')
  const [pendingSource, setPendingSource] = useState<string | null>(null)

  const manualLinks = useMemo(() => {
    const byId = new Map(placed.map(d => [d.id, d]))
    return deviceLinks
      .filter(l => byId.has(l.source_id) && byId.has(l.target_id))
      .map(l => ({ link: l, a: byId.get(l.source_id)!, b: byId.get(l.target_id)! }))
  }, [deviceLinks, placed])

  // In connect mode a marker click picks source then target instead of opening
  // the drawer; otherwise it selects the device as usual.
  const handleMarker = useCallback(
    (device: Device) => {
      if (!connectMode) { onSelect(device); return }
      setPendingSource(prev => {
        if (!prev) return device.id
        if (prev === device.id) return null
        createLink({ source_id: prev, target_id: device.id, kind: linkKind })
        return null
      })
    },
    [connectMode, linkKind, onSelect, createLink],
  )

  const enterConnect = () => {
    setConnectMode(true)
    // Reveal the links overlay — otherwise a link the user draws is saved but
    // invisible (the layer defaults off), so the feature looks broken.
    if (!showLinks) toggleLinks()
  }
  const exitConnect = () => { setConnectMode(false); setPendingSource(null) }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <style>{`
        @keyframes nmCritPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
        .nm-crit-pulse { animation: nmCritPulse 0.9s ease-in-out infinite; }
      `}</style>
      <MapContainer
        center={[40.3, 47.7]}
        zoom={7}
        // Cap zooming at the deepest level we actually have tiles for, so
        // users never zoom into an empty (blue) map.
        maxZoom={MAX_TILE_ZOOM}
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
            maxZoom={MAX_TILE_ZOOM}
            attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          />
        )}

        {/* Azerbaijani settlement names — our own label layer over the
            label-free basemap (see PlaceLabels.tsx). */}
        <PlaceLabels />

        {/* Mask out everything beyond the border → only AZ territory is shown. */}
        <CountryMask />

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

        {/* Topology: child → parent dependency lines (under the markers).
            Red dashed when either end is down, yellow when unknown. */}
        {showLinks && links.map(({ child, parent }) => {
          const down = child.current_status === 'offline' || parent.current_status === 'offline'
          const unknown = child.current_status === 'unknown' || parent.current_status === 'unknown'
          const color = down ? '#ef4444' : unknown ? '#eab308' : '#64748b'
          return (
            <Polyline
              key={`link-${child.id}`}
              positions={[
                [parent.latitude as number, parent.longitude as number],
                [child.latitude as number, child.longitude as number],
              ]}
              pathOptions={{
                color,
                weight: down ? 2.5 : 1.8,
                opacity: down ? 0.9 : 0.55,
                dashArray: down ? '6 6' : undefined,
              }}
            />
          )
        })}

        {/* Manually-drawn physical / logical links (same "Əlaqələr" layer). */}
        {showLinks && manualLinks.map(({ link, a, b }) => {
          const st = MANUAL_LINK_STYLE[link.kind] ?? MANUAL_LINK_STYLE.physical
          return (
            <Polyline
              key={`mlink-${link.id}`}
              positions={[
                [a.latitude as number, a.longitude as number],
                [b.latitude as number, b.longitude as number],
              ]}
              pathOptions={{ color: st.color, weight: 2.5, opacity: 0.85, dashArray: st.dash }}
            >
              <Tooltip sticky>{st.az} bağlantı{link.label ? ` · ${link.label}` : ''}</Tooltip>
            </Polyline>
          )
        })}

        {/* Cluster markers so the map stays smooth at 500+ devices: nearby pins
            collapse into a count bubble until you zoom in. Devices sharing an
            exact coordinate first collapse into a single "site" badge (below),
            which the cluster then treats as one marker. */}
        <MarkerClusterGroup chunkedLoading maxClusterRadius={50} disableClusteringAtZoom={11}>
          {soloDevices.map(device => (
            <DeviceMarker
              key={device.id}
              device={device}
              selected={device.id === selectedId || device.id === pendingSource}
              onSelect={handleMarker}
            />
          ))}
          {siteGroups.map(site => (
            <SiteMarker
              key={site.key}
              devices={site.devices}
              position={site.position}
              selectedId={selectedId}
              pendingSource={pendingSource}
              onSelect={handleMarker}
            />
          ))}
        </MarkerClusterGroup>
      </MapContainer>

      {/* Connections layer toggle + manual-link controls (top-right stack). */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        {(links.length > 0 || manualLinks.length > 0) && (
          <button
            onClick={toggleLinks}
            title={showLinks ? 'Əlaqə xətlərini gizlət' : 'Əlaqə xətlərini göstər'}
            style={{
              background: showLinks ? '#1e40af' : '#fff',
              color: showLinks ? '#fff' : '#475569',
              border: '1px solid ' + (showLinks ? '#1e40af' : '#cbd5e1'),
              borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            }}
          >
            🔗 Əlaqələr
          </button>
        )}

        {canEdit && !placing && (
          connectMode ? (
            <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 10, boxShadow: '0 2px 10px rgba(0,0,0,0.12)', padding: 10, width: 210 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', marginBottom: 6 }}>Əlaqələndirmə rejimi</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {(Object.keys(MANUAL_LINK_STYLE) as DeviceLinkKind[]).map(k => (
                  <button key={k} onClick={() => setLinkKind(k)}
                    style={{
                      flex: 1, padding: '5px 6px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', borderRadius: 6, fontFamily: 'inherit',
                      border: '1px solid ' + (linkKind === k ? MANUAL_LINK_STYLE[k].color : '#e2e8f0'),
                      background: linkKind === k ? MANUAL_LINK_STYLE[k].color : '#fff',
                      color: linkKind === k ? '#fff' : '#475569',
                    }}>
                    {MANUAL_LINK_STYLE[k].az}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: '#64748b', lineHeight: 1.5, marginBottom: 8 }}>
                {pendingSource
                  ? 'İndi hədəf cihaza klikləyin (mənbə seçildi).'
                  : 'Mənbə cihaza, sonra hədəf cihaza klikləyin.'}
              </div>
              <button onClick={exitConnect}
                style={{ width: '100%', padding: '6px', fontSize: 12, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569', fontFamily: 'inherit' }}>
                Bitir
              </button>
            </div>
          ) : (
            <button
              onClick={enterConnect}
              title="Cihazları xəritədə əl ilə əlaqələndir"
              style={{
                background: '#fff', color: '#0f766e', border: '1px solid #0d9488',
                borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}
            >
              ➕ Əlaqələndir
            </button>
          )
        )}
      </div>

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
