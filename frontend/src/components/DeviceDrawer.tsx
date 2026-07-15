import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { fetchEvents } from '../api/events'
import { DeviceForm } from './DeviceForm'
import { WebShell } from './WebShell'
import { LatencyChart } from './LatencyChart'
import { SnmpPanel } from './SnmpPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { StatusBadge } from './StatusBadge'
import { useAuth } from '../hooks/useAuth'
import type { Device, DeviceCreate, DeviceUpdate, SshFacts } from '../types'
import { DEVICE_TYPE_LABELS } from '../lib/deviceIcons'

// Right-hand device drawer, organised into tabs so each concern has room:
//   Ümumi       — status, badges, metadata, operational + edit controls
//   Monitorinq  — SNMP telemetry (perm: snmp), SSH facts (perm: ssh), latency
//   Diaqnostika — manual ping / traceroute
//   Tarixçə     — recent up/down events
// The backend is the authoritative permission gate; hiding here is cosmetic.

const SSH_STATUS: Record<string, { label: string; color: string }> = {
  ok:          { label: 'OK',            color: '#16a34a' },
  auth_failed: { label: 'Auth xətası',   color: '#ef4444' },
  unreachable: { label: 'Əlçatmaz',      color: '#ef4444' },
  error:       { label: 'Xəta',          color: '#f59e0b' },
  unknown:     { label: 'Yoxlanmayıb',   color: '#94a3b8' },
}

const EVT_LABEL = { came_online: '↑ Onlayn oldu', went_offline: '↓ Offlayn oldu' } as const
const EVT_COLOR = { came_online: '#16a34a', went_offline: '#ef4444' } as const

const STATUS_STRIPE: Record<string, string> = {
  online: '#16a34a', offline: '#ef4444', unknown: '#eab308',
}

type Tab = 'general' | 'monitoring' | 'diagnostics' | 'history'

const SECTION_TITLE: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
}

interface Props {
  device: Device | null
  isManager: boolean
  onClose: () => void
}

export function DeviceDrawer({ device, isManager, onClose }: Props) {
  const qc = useQueryClient()
  const { hasPermission } = useAuth()
  // Backend enforces these; the UI only hides controls the user can't use.
  const canSnmp = hasPermission('snmp') || isManager
  const canSsh = hasPermission('ssh') || isManager
  const canEditDevice = hasPermission('edit_device') || isManager
  const canEditConfig = hasPermission('edit_config') || isManager
  // Alarm acknowledgement is open to every authenticated user (ops decision).
  const canAck = true
  // Mute/maintenance is an admin action (per ops policy) — manager only.
  const canMute = isManager
  const [editing, setEditing] = useState(false)
  // Adding a NEW device at the edited device's location (rack/site sibling).
  const [addingAtLoc, setAddingAtLoc] = useState(false)
  const [showShell, setShowShell] = useState(false)
  const [tab, setTab] = useState<Tab>('general')

  useEffect(() => {
    setEditing(false); setAddingAtLoc(false); setShowShell(false); setTab('general')
  }, [device?.id])

  const { data: eventsData } = useQuery({
    queryKey: ['device-events', device?.id],
    queryFn: () => fetchEvents(1, 10, device!.id),
    enabled: !!device,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['devices'] })
  const deleteM = useMutation({
    mutationFn: devicesApi.remove,
    onSuccess: () => { invalidate(); onClose() },
  })
  const updateM = useMutation({
    mutationFn: ({ id, data }: { id: string; data: DeviceUpdate }) => devicesApi.update(id, data),
    onSuccess: () => { invalidate(); setEditing(false) },
  })
  // Create a new device (used by "add another at this location" from edit mode).
  const createM = useMutation({
    mutationFn: (data: DeviceCreate) => devicesApi.create(data),
    onSuccess: invalidate,
  })
  const simM = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'online' | 'offline' }) =>
      devicesApi.simulate(id, status),
    onSuccess: invalidate,
  })
  const sshM = useMutation({
    mutationFn: (id: string) => devicesApi.sshCheck(id),
    onSuccess: invalidate,
  })
  const ackM = useMutation({ mutationFn: (id: string) => devicesApi.ack(id), onSuccess: invalidate })
  const muteM = useMutation({
    mutationFn: ({ id, muted }: { id: string; muted: boolean }) => devicesApi.mute(id, muted),
    onSuccess: invalidate,
  })
  const maintM = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number | null }) =>
      devicesApi.maintenance(id, minutes),
    onSuccess: invalidate,
  })

  if (!device) return null

  const coords = device.latitude != null && device.longitude != null
    ? `${device.latitude.toFixed(5)}, ${device.longitude.toFixed(5)}`
    : null

  let sshFacts: SshFacts | null = null
  try { sshFacts = device.ssh_facts ? JSON.parse(device.ssh_facts) as SshFacts : null } catch { /* ignore */ }
  const sshSt = SSH_STATUS[device.ssh_status] ?? SSH_STATUS.unknown

  const allDev = qc.getQueryData<Device[]>(['devices']) ?? []
  const parent = device.parent_id ? allDev.find(d => d.id === device.parent_id) ?? null : null
  const parentDown = parent?.current_status === 'offline'
  const children = allDev.filter(d => d.parent_id === device.id)
  const underMaint = device.maintenance_until != null && new Date(device.maintenance_until) > new Date()

  const meta: [string, string | null | undefined][] = [
    ['Tip', DEVICE_TYPE_LABELS[device.device_type]],
    ['Model', device.model_name],
    ['Region', device.location_text],
    ['Parent', parent ? `${parent.vendor_name}${parentDown ? ' (DOWN)' : ''}` : null],
    ['Koordinatlar', coords],
    ['Təsvir', device.description],
    ['Ping', device.is_enabled ? 'Aktiv' : 'Söndürülüb'],
    ['Əlavə edilib', new Date(device.created_at).toLocaleDateString()],
  ]

  const TABS: { key: Tab; label: string }[] = [
    { key: 'general', label: 'Ümumi' },
    { key: 'monitoring', label: 'Monitorinq' },
    { key: 'diagnostics', label: 'Diaqnostika' },
    { key: 'history', label: 'Tarixçə' },
  ]

  return (
    <>
      {editing && (
        <DeviceForm
          device={device}
          allDevices={allDev}
          onSave={async (data) => { await updateM.mutateAsync({ id: device.id, data: data as DeviceUpdate }) }}
          onClose={() => setEditing(false)}
          onAddAnother={() => { setEditing(false); setAddingAtLoc(true) }}
        />
      )}

      {/* "Add another device at this location" — a fresh CREATE form pre-filled
          with this device's coordinates (so rack/site siblings are easy to add). */}
      {addingAtLoc && (
        <DeviceForm
          initialCoords={
            device.latitude != null && device.longitude != null
              ? { lat: device.latitude, lng: device.longitude }
              : undefined
          }
          allDevices={allDev}
          onSave={async (data) => { await createM.mutateAsync(data as DeviceCreate) }}
          onClose={() => setAddingAtLoc(false)}
        />
      )}

      {showShell && <WebShell device={device} onClose={() => setShowShell(false)} />}

      {/* Slide-in drawer */}
      <aside
        style={{
          position: 'fixed', top: 56, right: 0, bottom: 0, width: 360,
          background: '#fff', borderLeft: '1px solid #e2e8f0',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.07)',
          zIndex: 30, display: 'flex', flexDirection: 'column',
          fontFamily: 'system-ui, sans-serif',
          animation: 'slideIn 0.18s ease-out',
        }}
      >
        {/* Status stripe */}
        <div style={{ height: 3, background: STATUS_STRIPE[device.current_status] ?? '#94a3b8', flexShrink: 0 }} />

        {/* Header */}
        <div style={{
          padding: '12px 18px 10px', borderBottom: '1px solid #f1f5f9',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          background: '#fafafa', flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {device.is_critical && <span title="Kritik cihaz" style={{ color: '#dc2626' }}>⚠ </span>}
              {device.vendor_name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{device.ip_address}</span>
              <StatusBadge status={device.current_status} />
            </div>
            <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
              {device.last_checked_at
                ? `Son yoxlama: ${new Date(device.last_checked_at).toLocaleTimeString()}`
                : 'Hələ yoxlanmayıb'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Bağla"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 22, padding: '0 4px', lineHeight: 1, flexShrink: 0, marginLeft: 8 }}
          >×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#fff', flexShrink: 0 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                flex: 1, padding: '9px 4px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                background: 'none', border: 'none',
                borderBottom: '2px solid ' + (tab === t.key ? '#1e40af' : 'transparent'),
                color: tab === t.key ? '#1e40af' : '#64748b',
                fontWeight: tab === t.key ? 700 : 500,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
          {/* ── Ümumi ─────────────────────────────────────────────────────── */}
          {tab === 'general' && (
            <>
              {/* Condition badges */}
              {(() => {
                const badges: { label: string; bg: string; fg: string }[] = []
                if (underMaint) badges.push({ label: '🔧 Texniki iş', bg: '#dbeafe', fg: '#1e40af' })
                if (device.is_muted) badges.push({ label: '🔕 Susdurulub', bg: '#f1f5f9', fg: '#475569' })
                if (device.alarm_acked_at) badges.push({ label: '✓ Qəbul edilib', bg: '#fef3c7', fg: '#92400e' })
                if (device.service_ok === false) badges.push({ label: '⚠ Servis problemli', bg: '#fee2e2', fg: '#b91c1c' })
                else if (device.service_ok === true) badges.push({ label: '✓ Servis OK', bg: '#dcfce7', fg: '#166534' })
                if (device.current_status === 'offline' && parentDown) badges.push({ label: `↑ Parent down (${parent?.vendor_name})`, bg: '#e0e7ff', fg: '#3730a3' })
                return badges.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {badges.map(b => (
                      <span key={b.label} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: b.bg, color: b.fg }}>
                        {b.label}
                      </span>
                    ))}
                    {device.service_detail && (
                      <span style={{ fontSize: 10, color: '#94a3b8', width: '100%' }}>{device.service_detail}</span>
                    )}
                  </div>
                ) : null
              })()}

              {/* Operational controls */}
              {(canAck || canMute) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                  {canAck && (device.current_status === 'offline' || device.service_ok === false) && !device.alarm_acked_at && (
                    <button onClick={() => ackM.mutate(device.id)} disabled={ackM.isPending}
                      style={{ flex: 1, minWidth: 90, padding: '6px', borderRadius: 6, border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                      ✓ Qəbul et
                    </button>
                  )}
                  {canMute && (
                    <button onClick={() => muteM.mutate({ id: device.id, muted: !device.is_muted })} disabled={muteM.isPending}
                      style={{ flex: 1, minWidth: 90, padding: '6px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                      {device.is_muted ? '🔔 Səsi aç' : '🔕 Susdur'}
                    </button>
                  )}
                  {canMute && (
                    underMaint ? (
                      <button onClick={() => maintM.mutate({ id: device.id, minutes: 0 })} disabled={maintM.isPending}
                        style={{ flex: 1, minWidth: 90, padding: '6px', borderRadius: 6, border: '1px solid #93c5fd', background: '#eff6ff', color: '#1e40af', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                        🔧 Bitir
                      </button>
                    ) : (
                      <button onClick={() => maintM.mutate({ id: device.id, minutes: 60 })} disabled={maintM.isPending}
                        style={{ flex: 1, minWidth: 90, padding: '6px', borderRadius: 6, border: '1px solid #93c5fd', background: '#fff', color: '#1e40af', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                        🔧 Texniki iş 60d
                      </button>
                    )
                  )}
                </div>
              )}

              {/* Metadata */}
              <div style={SECTION_TITLE}>Cihaz məlumatı</div>
              <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 13px', marginBottom: 14, border: '1px solid #f1f5f9' }}>
                {meta.filter(([, v]) => v).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                    <span style={{ color: '#64748b', flexShrink: 0 }}>{label}</span>
                    <span style={{ color: '#1e293b', fontWeight: 500, textAlign: 'right', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Dependent (child) devices — their alarms are suppressed while
                  this device is down. */}
              {children.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={SECTION_TITLE}>Asılı cihazlar ({children.length})</div>
                  <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 13px', border: '1px solid #f1f5f9' }}>
                    {children.map(c => (
                      <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0' }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                          background: STATUS_STRIPE[c.current_status] ?? '#94a3b8',
                        }} />
                        <span style={{ color: '#1e293b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.vendor_name}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8', marginLeft: 'auto', flexShrink: 0 }}>
                          {c.ip_address}
                        </span>
                      </div>
                    ))}
                  </div>
                  {device.current_status === 'offline' && (
                    <p style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>
                      Bu cihaz down olduğu üçün asılı cihazların alarmları susdurulur.
                    </p>
                  )}
                </div>
              )}

              {/* Simulate (testing) */}
              {canEditConfig && (
                <div style={{ marginBottom: 12 }}>
                  <div style={SECTION_TITLE}>Test: status idarəsi</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => simM.mutate({ id: device.id, status: 'online' })}
                      disabled={simM.isPending || device.current_status === 'online'}
                      style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #86efac', background: device.current_status === 'online' ? '#dcfce7' : '#fff', color: '#16a34a', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, opacity: device.current_status === 'online' ? 0.6 : 1 }}>
                      ▲ Up et
                    </button>
                    <button
                      onClick={() => simM.mutate({ id: device.id, status: 'offline' })}
                      disabled={simM.isPending || device.current_status === 'offline'}
                      style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #fca5a5', background: device.current_status === 'offline' ? '#fee2e2' : '#fff', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, opacity: device.current_status === 'offline' ? 0.6 : 1 }}>
                      ▼ Down et
                    </button>
                  </div>
                </div>
              )}

              {/* Edit / delete */}
              {canEditDevice && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setEditing(true)}
                    style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 500 }}>
                    ✎ Redaktə
                  </button>
                  <button
                    onClick={() => { if (window.confirm(`${device.vendor_name} (${device.ip_address}) silinsin?`)) deleteM.mutate(device.id) }}
                    style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 500 }}>
                    🗑 Sil
                  </button>
                </div>
              )}
            </>
          )}

          {/* ── Monitorinq ────────────────────────────────────────────────── */}
          {tab === 'monitoring' && (
            <>
              {device.snmp_enabled && canSnmp && <SnmpPanel device={device} canPoll={canSnmp} />}
              {device.snmp_enabled && !canSnmp && (
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>
                  SNMP telemetriyası üçün icazəniz yoxdur.
                </div>
              )}

              {/* SSH telemetry */}
              {device.ssh_enabled && canSsh && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={SECTION_TITLE}>SSH telemetriya</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: sshSt.color }}>● {sshSt.label}</span>
                  </div>
                  <div style={{ background: '#f0fdfa', border: '1px solid #ccfbf1', borderRadius: 8, padding: '10px 13px', fontSize: 13 }}>
                    {[
                      ['Hostname', device.ssh_hostname],
                      ['Uptime', device.ssh_uptime],
                      ['Kernel', sshFacts?.kernel],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                        <span style={{ color: '#64748b' }}>{k}</span>
                        <span style={{ color: '#0f172a', fontWeight: 500, fontFamily: 'monospace', textAlign: 'right', marginLeft: 8 }}>{v}</span>
                      </div>
                    ))}
                    {sshFacts?.interfaces && sshFacts.interfaces.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ color: '#64748b', marginBottom: 4 }}>İnterfeyslər</div>
                        {sshFacts.interfaces.map(i => (
                          <div key={i.name} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: 12 }}>
                            <span style={{ color: '#0f766e', fontWeight: 600 }}>{i.name}</span>
                            <span style={{ color: '#0f172a' }}>{i.ipv4}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8' }}>
                      {device.ssh_collected_at
                        ? `Toplandı: ${new Date(device.ssh_collected_at).toLocaleTimeString()}`
                        : 'Hələ toplanmayıb'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => sshM.mutate(device.id)}
                      disabled={sshM.isPending}
                      style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #5eead4', background: '#fff', color: '#0f766e', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, opacity: sshM.isPending ? 0.6 : 1 }}>
                      {sshM.isPending ? 'Yoxlanılır…' : '⟳ SSH yoxla'}
                    </button>
                    <button
                      onClick={() => setShowShell(true)}
                      style={{ flex: 1, padding: '7px', borderRadius: 6, border: 'none', background: '#0f172a', color: '#5eead4', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>
                      🖥️ Web terminal
                    </button>
                  </div>
                </div>
              )}

              {/* Latency / uptime trend */}
              <LatencyChart deviceId={device.id} />

              {!device.snmp_enabled && !device.ssh_enabled && (
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 12 }}>
                  Bu cihazda SNMP/SSH telemetriyası qoşulmayıb — cihaz redaktəsindən aktivləşdirə bilərsiniz.
                </div>
              )}
            </>
          )}

          {/* ── Diaqnostika ───────────────────────────────────────────────── */}
          {tab === 'diagnostics' && <DiagnosticsPanel device={device} />}

          {/* ── Tarixçə ───────────────────────────────────────────────────── */}
          {tab === 'history' && (
            <>
              <div style={SECTION_TITLE}>Son hadisələr</div>
              {!eventsData || eventsData.items.length === 0 ? (
                <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>Hələ hadisə yoxdur.</p>
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
            </>
          )}
        </div>
      </aside>

      <style>{`@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </>
  )
}
