import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { AzerbaijanMap } from '../components/AzerbaijanMap'
import { DeviceDrawer } from '../components/DeviceDrawer'
import { DeviceForm } from '../components/DeviceForm'
import { NetworkGraph } from '../components/NetworkGraph'
import { StatusBadge } from '../components/StatusBadge'
import { SlaView } from '../components/SlaView'
import { HeartbeatBadge } from '../components/HeartbeatBadge'
import { Toaster, type Toast } from '../components/Toaster'
import { useAuth } from '../hooks/useAuth'
import { useWebSocket } from '../hooks/useWebSocket'
import { playAlert, isSoundEnabled, setSoundEnabled } from '../lib/sound'
import type { Device, DeviceCreate, WsStatusMessage, WsBatchMessage } from '../types'

const WS_PROTO = window.location.protocol === 'https:' ? 'wss' : 'ws'

type View = 'map' | 'graph' | 'table' | 'sla'
type Coords = { lat: number; lng: number }

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 10, padding: '14px 18px',
      border: '1px solid #e2e8f0', minWidth: 110, flex: '1 1 110px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 4, fontWeight: 500 }}>{label}</div>
    </div>
  )
}

export function Dashboard() {
  const { user, logout, isManager, hasPermission } = useAuth()
  // Device-editing affordances: managers + engineers. Backend still enforces.
  const canEdit = hasPermission('edit_device') || isManager
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [view, setView] = useState<View>('map')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [regionFilter, setRegionFilter] = useState<string>('all')
  const [criticalOnly, setCriticalOnly] = useState(false)
  const [selected, setSelected] = useState<Device | null>(null)
  const [adding, setAdding] = useState(false)
  const [placing, setPlacing] = useState(false)        // map placement mode
  const [newCoords, setNewCoords] = useState<Coords | null>(null)
  const [soundOn, setSoundOn] = useState(isSoundEnabled)

  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    setSoundEnabled(next)   // persists + unlocks the AudioContext (this click is a user gesture)
  }

  const startAdd = () => {
    if (view === 'map') { setPlacing(true) }
    else { setNewCoords(null); setAdding(true) }
  }
  const closeForm = () => { setAdding(false); setNewCoords(null) }
  const placeAt = (lat: number, lng: number) => {
    setNewCoords({ lat, lng }); setPlacing(false); setAdding(true)
  }

  // Served from Redis, so polling is cheap; keeps service/maintenance state fresh.
  const { data: devices = [] } = useQuery({
    queryKey: ['devices'], queryFn: devicesApi.list, refetchInterval: 30_000,
  })

  const createM = useMutation({
    mutationFn: devicesApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  // ── Toast notifications (with sound, auto-close after 10s) ───────────────
  const [toasts, setToasts] = useState<Toast[]>([])
  const closeToast = useCallback((id: string) => {
    setToasts(t => t.filter(x => x.id !== id))
  }, [])
  const addToast = useCallback((kind: 'down' | 'up', dev: Device) => {
    const id = crypto.randomUUID()
    const critical = kind === 'down' && dev.is_critical
    const title = kind === 'down'
      ? `⚠ ${dev.vendor_name} DOWN oldu`
      : `✓ ${dev.vendor_name} BƏRPA olundu`
    const detail = `${dev.ip_address}${dev.location_text ? ' · ' + dev.location_text : ''}`
    setToasts(t => [...t, { id, kind, critical, title, detail }])
    // Critical-device down → distinct urgent siren; otherwise standard tones.
    playAlert(critical ? 'critical' : kind)
    // Critical alerts stay until acknowledged (quick reaction). Others auto-close after 10s.
    if (!critical) {
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 10_000)
    }
  }, [])

  const wsUrl = user ? `${WS_PROTO}://${window.location.host}/ws/status?token=${user.token}` : null

  const handleSelect = useCallback((d: Device) => {
    setSelected(prev => (prev?.id === d.id ? null : d))
  }, [])

  const handleWs = useCallback((raw: string) => {
    const msg = JSON.parse(raw) as WsStatusMessage | WsBatchMessage
    // The gateway coalesces changes into a 250ms batch frame; older single
    // frames are still handled for safety.
    const changes = 'type' in msg && msg.type === 'batch' ? msg.changes : [msg as WsStatusMessage]
    if (changes.length === 0) return

    // Detect transitions against the cached previous status → fire toasts.
    const prev = qc.getQueryData<Device[]>(['devices'])
    for (const c of changes) {
      const dev = prev?.find(d => d.id === c.device_id)
      if (dev && dev.current_status !== c.status) {
        if (c.status === 'offline') addToast('down', dev)
        else if (c.status === 'online') addToast('up', dev)
      }
    }

    // Apply the whole batch in ONE cache update → a single re-render. Unchanged
    // devices keep their object reference, so their memoized markers don't redraw.
    const byId = new Map(changes.map(c => [c.device_id, c]))
    qc.setQueryData<Device[]>(['devices'], p =>
      p?.map(d => {
        const c = byId.get(d.id)
        return c ? { ...d, current_status: c.status, last_checked_at: c.last_checked_at } : d
      }),
    )
  }, [qc, addToast])

  useWebSocket(wsUrl, handleWs)

  // Keep the open drawer's device in sync with live status changes.
  useEffect(() => {
    setSelected(sel => {
      if (!sel) return sel
      const fresh = devices.find(d => d.id === sel.id)
      return fresh && fresh !== sel ? fresh : sel
    })
  }, [devices])

  // Stats
  const total   = devices.length
  const online  = devices.filter(d => d.current_status === 'online').length
  const offline = devices.filter(d => d.current_status === 'offline').length
  const unknown = devices.filter(d => d.current_status === 'unknown').length
  const uptimePct = total > 0 ? Math.round((online / total) * 100) : 0

  // Distinct regions for the group-by / filter dropdown.
  const regions = Array.from(new Set(devices.map(d => d.location_text).filter(Boolean) as string[])).sort()

  // Filtered list (search + status + region + critical-only)
  const filtered = devices.filter(d => {
    const matchSearch = !search ||
      d.vendor_name.toLowerCase().includes(search.toLowerCase()) ||
      d.ip_address.includes(search) ||
      (d.model_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (d.location_text ?? '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || d.current_status === statusFilter
    const matchRegion = regionFilter === 'all' || (d.location_text ?? '—') === regionFilter
    const matchCritical = !criticalOnly || d.is_critical
    return matchSearch && matchStatus && matchRegion && matchCritical
  })

  const drawerOpen = selected !== null

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={{
        height: 56, background: '#0f172a', color: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
        position: 'sticky', top: 0, zIndex: 50, flexShrink: 0,
      }}>
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.3px', color: '#f1f5f9', flexShrink: 0 }}>
          NetMonitor
        </div>
        <nav style={{ display: 'flex', gap: 2 }}>
          {([
            ['Devices', '/'],
            ['Events', '/events'],
            ...(hasPermission('manage_users') || isManager ? [['⚙ Admin', '/admin']] : []),
          ] as [string, string][]).map(([label, path]) => (
            <button key={label} onClick={() => navigate(path)}
              style={{
                background: path === '/' ? 'rgba(255,255,255,0.12)' : 'transparent',
                border: 'none', color: path === '/' ? '#fff' : '#94a3b8',
                borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13,
                fontFamily: 'inherit', fontWeight: 500,
              }}>
              {label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={toggleSound}
            title={soundOn ? 'Səs xəbərdarlıqları: aktiv' : 'Səs xəbərdarlıqları: söndürülüb'}
            aria-label="Səs xəbərdarlıqları"
            aria-pressed={soundOn}
            style={{
              background: 'transparent', border: '1px solid #334155',
              color: soundOn ? '#93c5fd' : '#64748b', borderRadius: 6,
              padding: '4px 9px', cursor: 'pointer', fontSize: 14, lineHeight: 1,
              fontFamily: 'inherit',
            }}>
            {soundOn ? '🔔' : '🔕'}
          </button>
          <HeartbeatBadge />
          <span style={{ fontSize: 12, color: '#475569' }}>{user?.email}</span>
          <span style={{ fontSize: 11, background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '2px 7px', fontWeight: 600 }}>
            {user?.role}
          </span>
          <button onClick={() => { logout(); navigate('/login') }}
            style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 11px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
            Logout
          </button>
        </div>
      </header>

      {/* ── Stats bar ──────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '14px 20px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <StatCard label="Total Devices" value={total}   color="#1e293b" />
          <StatCard label="Online"         value={online}  color="#16a34a" />
          <StatCard label="Offline"        value={offline} color="#ef4444" />
          <StatCard label="Unknown"        value={unknown} color="#eab308" />

          {/* Uptime bar */}
          {total > 0 && (
            <div style={{ flex: '2 1 200px', background: '#f8fafc', borderRadius: 10, padding: '14px 18px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Uptime</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: uptimePct >= 80 ? '#16a34a' : uptimePct >= 50 ? '#f59e0b' : '#ef4444' }}>
                  {uptimePct}%
                </span>
              </div>
              <div style={{ height: 8, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 99, transition: 'width 0.6s ease',
                  width: `${uptimePct}%`,
                  background: uptimePct >= 80 ? '#16a34a' : uptimePct >= 50 ? '#f59e0b' : '#ef4444',
                }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* View toggle */}
        <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 7, padding: 3, gap: 2 }}>
          {(['map', 'graph', 'table', 'sla'] as View[]).map(v => (
            <button key={v} onClick={() => setView(v)}
              style={{
                background: view === v ? '#fff' : 'transparent',
                border: 'none', borderRadius: 5,
                padding: '5px 14px', cursor: 'pointer', fontSize: 13,
                fontWeight: view === v ? 600 : 400,
                color: view === v ? '#1e293b' : '#64748b',
                boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                fontFamily: 'inherit',
                textTransform: 'capitalize',
              }}>
              {v === 'map' ? '🗺 Map' : v === 'graph' ? '⬡ Graph' : '≡ Table'}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          placeholder="Search devices…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '6px 12px', border: '1px solid #e2e8f0', borderRadius: 7,
            fontSize: 13, outline: 'none', width: 200, fontFamily: 'inherit',
            background: '#fafafa',
          }}
        />

        {/* Status filter */}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fafafa', cursor: 'pointer' }}>
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>

        {/* Region filter */}
        <select value={regionFilter} onChange={e => setRegionFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fafafa', cursor: 'pointer' }}>
          <option value="all">Bütün regionlar</option>
          {regions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>

        {/* Critical-only toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#b91c1c', fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)} />
          ⚠ Yalnız kritik
        </label>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && placing && (
            <>
              <span style={{ fontSize: 12, color: '#1e40af', fontWeight: 600 }}>
                Xəritəyə klikləyin…
              </span>
              <button onClick={() => { setPlacing(false); setNewCoords(null); setAdding(true) }}
                style={{ background: '#fff', color: '#1e40af', border: '1px solid #c7d2fe', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                Konumsuz əlavə et
              </button>
              <button onClick={() => setPlacing(false)}
                style={{ background: '#fff', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                Ləğv et
              </button>
            </>
          )}
          {canEdit && !placing && (
            <button onClick={startAdd}
              style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              + Add Device
            </button>
          )}
        </div>
      </div>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', transition: 'margin-right 0.2s', marginRight: drawerOpen ? 360 : 0 }}>

          {/* Map view */}
          {view === 'map' && (
            <div style={{ width: '100%', height: '100%' }}>
              <AzerbaijanMap
                devices={search || statusFilter !== 'all' ? filtered : devices}
                selectedId={selected?.id ?? null}
                onSelect={handleSelect}
                placing={placing}
                onMapClick={placeAt}
              />
            </div>
          )}

          {/* Graph view */}
          {view === 'graph' && (
            <div style={{ width: '100%', height: '100%' }}>
              {devices.length === 0 ? (
                <EmptyState isManager={canEdit} onAdd={() => setAdding(true)} />
              ) : (
                <NetworkGraph
                  devices={search || statusFilter !== 'all' ? filtered : devices}
                  selectedId={selected?.id ?? null}
                  onSelect={handleSelect}
                />
              )}
            </div>
          )}

          {/* Table view */}
          {view === 'table' && (
            <div style={{ padding: 20 }}>
              <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
                    {devices.length === 0
                      ? isManager ? 'No devices. Click "+ Add Device" to get started.' : 'No devices yet.'
                      : 'No devices match your search.'}
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        {['Vendor', 'IP Address', 'Model', 'Location', 'Status', 'Last Checked', ...(isManager ? ['Actions'] : [])].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #e2e8f0' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(d => (
                        <tr
                          key={d.id}
                          onClick={() => setSelected(prev => prev?.id === d.id ? null : d)}
                          style={{
                            opacity: d.is_enabled ? 1 : 0.5,
                            cursor: 'pointer',
                            background: selected?.id === d.id ? '#eff6ff' : 'transparent',
                          }}
                        >
                          <td style={{ padding: '11px 14px', fontSize: 14, color: '#1e293b', fontWeight: 500, borderBottom: '1px solid #f1f5f9' }}>{d.vendor_name}</td>
                          <td style={{ padding: '11px 14px', fontFamily: 'monospace', fontSize: 13, color: '#475569', borderBottom: '1px solid #f1f5f9' }}>{d.ip_address}</td>
                          <td style={{ padding: '11px 14px', fontSize: 13, color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>{d.model_name ?? '—'}</td>
                          <td style={{ padding: '11px 14px', fontSize: 13, color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>{d.location_text ?? '—'}</td>
                          <td style={{ padding: '11px 14px', borderBottom: '1px solid #f1f5f9' }}><StatusBadge status={d.current_status} /></td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
                            {d.last_checked_at ? new Date(d.last_checked_at).toLocaleTimeString() : '—'}
                          </td>
                          {isManager && (
                            <td style={{ padding: '11px 14px', borderBottom: '1px solid #f1f5f9' }} onClick={e => e.stopPropagation()}>
                              <button onClick={() => setSelected(d)}
                                style={{ padding: '3px 10px', fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 5, background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                                Details
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* SLA / uptime view */}
          {view === 'sla' && <SlaView />}
        </div>

        {/* Device drawer */}
        <DeviceDrawer
          device={selected}
          isManager={isManager}
          onClose={() => setSelected(null)}
        />
      </div>

      {/* Add device modal */}
      {adding && (
        <DeviceForm
          initialCoords={newCoords ?? undefined}
          allDevices={devices}
          onSave={async (data) => { await createM.mutateAsync(data as DeviceCreate) }}
          onClose={closeForm}
        />
      )}

      {/* Status notifications (sound + auto-close) */}
      <Toaster toasts={toasts} onClose={closeToast} />
    </div>
  )
}

function EmptyState({ isManager, onAdd }: { isManager: boolean; onAdd: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: '#94a3b8' }}>
      <div style={{ fontSize: 48 }}>⬡</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#64748b' }}>No devices yet</div>
      {isManager && (
        <button onClick={onAdd}
          style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', marginTop: 4 }}>
          + Add your first device
        </button>
      )}
    </div>
  )
}
