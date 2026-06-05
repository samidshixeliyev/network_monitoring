import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchEvents } from '../api/events'
import { devicesApi } from '../api/devices'
import { useAuth } from '../hooks/useAuth'
import type { EventType } from '../types'

const EVT_LABEL: Record<EventType, string> = { came_online: 'Came Online', went_offline: 'Went Offline' }
const EVT_COLOR: Record<EventType, string> = { came_online: '#16a34a', went_offline: '#ef4444' }
const EVT_ICON:  Record<EventType, string> = { came_online: '↑', went_offline: '↓' }

const PAGE_SIZE = 50

export function EventLog() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<EventType | 'all'>('all')

  const { data: eventsData, isLoading } = useQuery({
    queryKey: ['events', page, filter],
    queryFn: () => fetchEvents(page, PAGE_SIZE),
  })

  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d]))

  const items = (eventsData?.items ?? []).filter(e => filter === 'all' || e.event_type === filter)
  const totalPages = eventsData ? Math.max(1, Math.ceil(eventsData.total / PAGE_SIZE)) : 1

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        height: 56, background: '#0f172a', color: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
        position: 'sticky', top: 0, zIndex: 50, flexShrink: 0,
      }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: '#f1f5f9', flexShrink: 0 }}>NetMonitor</div>
        <nav style={{ display: 'flex', gap: 2 }}>
          {[['Devices', '/'], ['Events', '/events']].map(([label, path]) => (
            <button key={label} onClick={() => navigate(path)}
              style={{
                background: path === '/events' ? 'rgba(255,255,255,0.12)' : 'transparent',
                border: 'none', color: path === '/events' ? '#fff' : '#94a3b8',
                borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13,
                fontFamily: 'inherit', fontWeight: 500,
              }}>
              {label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: '#475569' }}>{user?.email}</span>
          <span style={{ fontSize: 11, background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '2px 7px', fontWeight: 600 }}>{user?.role}</span>
          <button onClick={() => { logout(); navigate('/login') }}
            style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 11px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
            Logout
          </button>
        </div>
      </header>

      <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', width: '100%' }}>
        {/* Title + filter row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>Event Log</h2>
            {eventsData && (
              <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>{eventsData.total} total events</p>
            )}
          </div>
          <select
            value={filter}
            onChange={e => { setFilter(e.target.value as EventType | 'all'); setPage(1) }}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}
          >
            <option value="all">All events</option>
            <option value="came_online">Came Online only</option>
            <option value="went_offline">Went Offline only</option>
          </select>
        </div>

        {/* Events list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
              No events recorded yet.
            </div>
          ) : items.map(e => {
            const device = deviceMap[e.device_id]
            return (
              <div key={e.id}
                style={{
                  background: '#fff', borderRadius: 9, border: '1px solid #e2e8f0',
                  padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                }}
              >
                {/* Icon */}
                <div style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  background: e.event_type === 'came_online' ? '#f0fdf4' : '#fef2f2',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, fontWeight: 700, color: EVT_COLOR[e.event_type],
                }}>
                  {EVT_ICON[e.event_type]}
                </div>

                {/* Event info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: EVT_COLOR[e.event_type] }}>
                      {EVT_LABEL[e.event_type]}
                    </span>
                    {device && (
                      <>
                        <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500 }}>{device.vendor_name}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>
                          {device.ip_address}
                        </span>
                        {device.location_text && (
                          <span style={{ fontSize: 12, color: '#94a3b8' }}>{device.location_text}</span>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3, fontFamily: 'monospace' }}>
                    {e.device_id}
                  </div>
                </div>

                {/* Timestamp */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 13, color: '#475569', fontWeight: 500 }}>
                    {new Date(e.created_at).toLocaleTimeString()}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {new Date(e.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20 }}>
            <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
              style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: page === 1 ? 'default' : 'pointer', fontSize: 13, opacity: page === 1 ? 0.4 : 1, fontFamily: 'inherit' }}>
              ← Prev
            </button>
            <span style={{ fontSize: 13, color: '#64748b', padding: '0 6px' }}>
              Page {page} / {totalPages}
            </span>
            <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
              style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: page === totalPages ? 'default' : 'pointer', fontSize: 13, opacity: page === totalPages ? 0.4 : 1, fontFamily: 'inherit' }}>
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
