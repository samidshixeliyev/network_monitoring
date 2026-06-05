import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { fetchEvents } from '../api/events'
import { DeviceForm } from './DeviceForm'
import { StatusBadge } from './StatusBadge'
import type { Device, DeviceUpdate } from '../types'

const EVT_LABEL = { came_online: '↑ Came Online', went_offline: '↓ Went Offline' } as const
const EVT_COLOR = { came_online: '#16a34a', went_offline: '#ef4444' } as const

interface Props {
  device: Device | null
  isManager: boolean
  onClose: () => void
}

export function DeviceDrawer({ device, isManager, onClose }: Props) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)

  useEffect(() => { setEditing(false) }, [device?.id])

  const { data: eventsData } = useQuery({
    queryKey: ['device-events', device?.id],
    queryFn: () => fetchEvents(1, 10, device!.id),
    enabled: !!device,
  })

  const deleteM = useMutation({
    mutationFn: devicesApi.remove,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); onClose() },
  })

  const updateM = useMutation({
    mutationFn: ({ id, data }: { id: string; data: DeviceUpdate }) => devicesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); setEditing(false) },
  })

  if (!device) return null

  const meta: [string, string | null | undefined][] = [
    ['Model', device.model_name],
    ['Location', device.location_text],
    ['Description', device.description],
    ['Ping', device.is_enabled ? 'Enabled' : 'Disabled'],
  ]

  return (
    <>
      {editing && (
        <DeviceForm
          device={device}
          onSave={async (data) => { await updateM.mutateAsync({ id: device.id, data: data as DeviceUpdate }) }}
          onClose={() => setEditing(false)}
        />
      )}

      {/* Slide-in drawer */}
      <aside
        style={{
          position: 'fixed', top: 56, right: 0, bottom: 0, width: 340,
          background: '#fff', borderLeft: '1px solid #e2e8f0',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.07)',
          zIndex: 30, display: 'flex', flexDirection: 'column',
          fontFamily: 'system-ui, sans-serif',
          animation: 'slideIn 0.18s ease-out',
        }}
      >
        {/* Drawer header */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid #f1f5f9',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          background: '#fafafa',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {device.vendor_name}
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {device.ip_address}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 22, padding: '0 4px', lineHeight: 1, flexShrink: 0, marginLeft: 8 }}
          >×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          {/* Status row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <StatusBadge status={device.current_status} />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {device.last_checked_at
                ? `Checked ${new Date(device.last_checked_at).toLocaleTimeString()}`
                : 'Never checked'}
            </span>
          </div>

          {/* Metadata card */}
          <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 13px', marginBottom: 14, border: '1px solid #f1f5f9' }}>
            {meta.filter(([, v]) => v).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#64748b', flexShrink: 0 }}>{label}</span>
                <span style={{ color: '#1e293b', fontWeight: 500, textAlign: 'right', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {value}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#64748b' }}>Added</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>
                {new Date(device.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>

          {/* Manager actions */}
          {isManager && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <button
                onClick={() => setEditing(true)}
                style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 500 }}
              >
                Edit
              </button>
              <button
                onClick={() => { if (window.confirm(`Delete ${device.vendor_name} (${device.ip_address})?`)) deleteM.mutate(device.id) }}
                style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 500 }}
              >
                Delete
              </button>
            </div>
          )}

          {/* Event history */}
          <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Recent Events
          </div>
          {!eventsData || eventsData.items.length === 0 ? (
            <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>No events yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {eventsData.items.map(e => (
                <div
                  key={e.id}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '7px 10px', borderRadius: 6, background: '#f8fafc',
                    border: '1px solid #f1f5f9',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: EVT_COLOR[e.event_type] }}>
                    {EVT_LABEL[e.event_type]}
                  </span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    {new Date(e.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <style>{`@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </>
  )
}
