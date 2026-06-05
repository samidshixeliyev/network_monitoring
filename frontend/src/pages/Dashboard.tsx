import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { DeviceDrawer } from '../components/DeviceDrawer'
import { DeviceForm } from '../components/DeviceForm'
import { NetworkGraph } from '../components/NetworkGraph'
import { StatusBadge } from '../components/StatusBadge'
import { useAuth } from '../hooks/useAuth'
import { useWebSocket } from '../hooks/useWebSocket'
import type { Device, DeviceCreate, WsStatusMessage } from '../types'

const WS_PROTO = window.location.protocol === 'https:' ? 'wss' : 'ws'

type View = 'graph' | 'table'

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
  const { user, logout, isManager } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [view, setView] = useState<View>('graph')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selected, setSelected] = useState<Device | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })

  const createM = useMutation({
    mutationFn: devicesApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  const wsUrl = user ? `${WS_PROTO}://${window.location.host}/ws/status?token=${user.token}` : null

  const handleWs = useCallback((raw: string) => {
    const msg = JSON.parse(raw) as WsStatusMessage
    qc.setQueryData<Device[]>(['devices'], prev =>
      prev?.map(d => d.id === msg.device_id
        ? { ...d, current_status: msg.status, last_checked_at: msg.last_checked_at }
        : d,
      ),
    )
  }, [qc])

  useWebSocket(wsUrl, handleWs)

  // Stats
  const total   = devices.length
  const online  = devices.filter(d => d.current_status === 'online').length
  const offline = devices.filter(d => d.current_status === 'offline').length
  const unknown = devices.filter(d => d.current_status === 'unknown').length
  const uptimePct = total > 0 ? Math.round((online / total) * 100) : 0

  // Filtered list for table view
  const filtered = devices.filter(d => {
    const matchSearch = !search ||
      d.vendor_name.toLowerCase().includes(search.toLowerCase()) ||
      d.ip_address.includes(search) ||
      (d.model_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (d.location_text ?? '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || d.current_status === statusFilter
    return matchSearch && matchStatus
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
          {[['Devices', '/'], ['Events', '/events']].map(([label, path]) => (
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
          <StatCard label="Unknown"        value={unknown} color="#94a3b8" />

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
          {(['graph', 'table'] as View[]).map(v => (
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
              {v === 'graph' ? '⬡ Graph' : '≡ Table'}
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

        <div style={{ marginLeft: 'auto' }}>
          {isManager && (
            <button onClick={() => setAdding(true)}
              style={{ background: '#1e40af', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              + Add Device
            </button>
          )}
        </div>
      </div>

      {/* ── Main area ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', transition: 'margin-right 0.2s', marginRight: drawerOpen ? 340 : 0 }}>

          {/* Graph view */}
          {view === 'graph' && (
            <div style={{ width: '100%', height: '100%' }}>
              {devices.length === 0 ? (
                <EmptyState isManager={isManager} onAdd={() => setAdding(true)} />
              ) : (
                <NetworkGraph
                  devices={search || statusFilter !== 'all' ? filtered : devices}
                  selectedId={selected?.id ?? null}
                  onSelect={d => setSelected(prev => prev?.id === d.id ? null : d)}
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
          onSave={async (data) => { await createM.mutateAsync(data as DeviceCreate) }}
          onClose={() => setAdding(false)}
        />
      )}
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
