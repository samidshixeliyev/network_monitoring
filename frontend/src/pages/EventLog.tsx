import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchEvents } from '../api/events'
import { fetchSyslog } from '../api/syslog'
import { fetchSnmpTraps } from '../api/snmpTraps'
import { devicesApi } from '../api/devices'
import { useAuth } from '../hooks/useAuth'
import type { Device, EventType, EventLog as EventLogEntry, SnmpTrap, SyslogMessage } from '../types'

const EVT_LABEL: Record<EventType, string> = { came_online: 'Onlayn oldu', went_offline: 'Oflayn oldu' }
const EVT_COLOR: Record<EventType, string> = { came_online: '#16a34a', went_offline: '#ef4444' }
const EVT_ICON:  Record<EventType, string> = { came_online: '↑', went_offline: '↓' }

// Syslog severity (RFC5424): number → label + color.
const SEV_LABEL = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']
const SEV_COLOR = ['#7f1d1d', '#b91c1c', '#dc2626', '#ea580c', '#d97706', '#0284c7', '#64748b', '#94a3b8']

const PAGE_SIZE = 50

export function EventLog() {
  const { user, logout, hasPermission } = useAuth()
  const navigate = useNavigate()
  const [page, setPage] = useState<'all' | 'device'>('all')

  const navItems: [string, string][] = [['Cihazlar', '/'], ['Loglar', '/events']]
  if (hasPermission('edit_device')) navItems.push(['Kəşf', '/discovery'])

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
          {navItems.map(([label, path]) => (
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
            Çıxış
          </button>
        </div>
      </header>

      <div style={{ padding: 20, maxWidth: 940, margin: '0 auto', width: '100%' }}>
        {/* Two log pages: everything (by date) vs one device at a time */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#e2e8f0', borderRadius: 9, padding: 3, width: 'fit-content' }}>
          {([['all', 'Bütün loglar'], ['device', 'Cihaz üzrə']] as const).map(([key, tabLabel]) => (
            <button key={key} onClick={() => setPage(key)}
              style={{
                padding: '6px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: page === key ? '#fff' : 'transparent',
                color: page === key ? '#0f172a' : '#64748b',
                boxShadow: page === key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}>
              {tabLabel}
            </button>
          ))}
        </div>

        {page === 'all' ? <AllLogsPage /> : <DeviceLogsPage />}
      </div>
    </div>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────
function Pagination({ page, totalPages, setPage }: { page: number; totalPages: number; setPage: (fn: (p: number) => number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20 }}>
      <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
        style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: page === 1 ? 'default' : 'pointer', fontSize: 13, opacity: page === 1 ? 0.4 : 1, fontFamily: 'inherit' }}>
        ← Əvvəlki
      </button>
      <span style={{ fontSize: 13, color: '#64748b', padding: '0 6px' }}>
        Səhifə {page} / {totalPages}
      </span>
      <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
        style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: page === totalPages ? 'default' : 'pointer', fontSize: 13, opacity: page === totalPages ? 0.4 : 1, fontFamily: 'inherit' }}>
        Növbəti →
      </button>
    </div>
  )
}

function EventRow({ e, device }: { e: EventLogEntry; device?: Device }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 9, border: '1px solid #e2e8f0',
      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: e.event_type === 'came_online' ? '#f0fdf4' : '#fef2f2',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, fontWeight: 700, color: EVT_COLOR[e.event_type],
      }}>
        {EVT_ICON[e.event_type]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: EVT_COLOR[e.event_type] }}>{EVT_LABEL[e.event_type]}</span>
          {device && (
            <>
              <span style={{ fontSize: 13, color: '#1e293b', fontWeight: 500 }}>{device.vendor_name}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '1px 6px', borderRadius: 4 }}>{device.ip_address}</span>
              {device.location_text && <span style={{ fontSize: 12, color: '#94a3b8' }}>{device.location_text}</span>}
            </>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: '#475569', fontWeight: 500 }}>{new Date(e.created_at).toLocaleTimeString()}</div>
        <div style={{ fontSize: 11, color: '#94a3b8' }}>{new Date(e.created_at).toLocaleDateString()}</div>
      </div>
    </div>
  )
}

function SyslogRow({ m, device }: { m: SyslogMessage; device?: Device }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0',
      borderLeft: `3px solid ${SEV_COLOR[m.severity] ?? '#94a3b8'}`,
      padding: '8px 14px', display: 'flex', alignItems: 'baseline', gap: 10,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: '#fff', borderRadius: 4, padding: '2px 6px',
        background: SEV_COLOR[m.severity] ?? '#94a3b8', textTransform: 'uppercase', flexShrink: 0,
      }}>
        {SEV_LABEL[m.severity] ?? m.severity}
      </span>
      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#334155', flexShrink: 0 }}>
        {device ? device.vendor_name : m.host}
      </span>
      {m.app_name && (
        <span style={{ fontSize: 11, color: '#64748b', background: '#f1f5f9', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>{m.app_name}</span>
      )}
      <span style={{ fontSize: 13, color: '#1e293b', flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{m.message}</span>
      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, fontFamily: 'monospace' }}>{new Date(m.ts).toLocaleString()}</span>
    </div>
  )
}

function TrapRow({ t, device }: { t: SnmpTrap; device?: Device }) {
  const color = SEV_COLOR[t.severity] ?? '#94a3b8'
  return (
    <div style={{
      background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0',
      borderLeft: `3px solid ${color}`,
      padding: '8px 14px', display: 'flex', alignItems: 'baseline', gap: 10,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: '#fff', borderRadius: 4, padding: '2px 6px',
        background: color, textTransform: 'uppercase', flexShrink: 0,
      }}>
        {SEV_LABEL[t.severity] ?? t.severity}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', flexShrink: 0 }}>{t.trap_name}</span>
      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#334155', flexShrink: 0 }}>
        {device ? device.vendor_name : t.host}
      </span>
      <span style={{ fontSize: 11, color: '#64748b', background: '#f1f5f9', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>v{t.version}</span>
      <span style={{ fontSize: 13, color: '#475569', flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{t.message}</span>
      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, fontFamily: 'monospace' }}>{new Date(t.ts).toLocaleString()}</span>
    </div>
  )
}

const emptyBox = (text: string) => (
  <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>{text}</div>
)

// ── Page 1: all logs, newest first ────────────────────────────────────────────
function AllLogsPage() {
  const [tab, setTab] = useState<'events' | 'syslog' | 'traps'>('events')
  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#e2e8f0', borderRadius: 9, padding: 3, width: 'fit-content' }}>
        {([['events', 'Status hadisələri'], ['syslog', 'Syslog'], ['traps', 'SNMP Trap']] as const).map(([key, tabLabel]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              padding: '6px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              background: tab === key ? '#fff' : 'transparent',
              color: tab === key ? '#0f172a' : '#64748b',
              boxShadow: tab === key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}>
            {tabLabel}
          </button>
        ))}
      </div>
      {tab === 'events' ? <EventsTab /> : tab === 'syslog' ? <SyslogTab /> : <TrapsTab />}
    </>
  )
}

function EventsTab() {
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<EventType | 'all'>('all')

  const { data: eventsData, isLoading } = useQuery({
    queryKey: ['events', page],
    queryFn: () => fetchEvents(page, PAGE_SIZE),
  })
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d]))

  const items = (eventsData?.items ?? []).filter(e => filter === 'all' || e.event_type === filter)
  const totalPages = eventsData ? Math.max(1, Math.ceil(eventsData.total / PAGE_SIZE)) : 1

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>Hadisə jurnalı</h2>
          {eventsData && <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>{eventsData.total} ümumi hadisə</p>}
        </div>
        <select value={filter} onChange={e => { setFilter(e.target.value as EventType | 'all'); setPage(1) }}
          style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}>
          <option value="all">Bütün hadisələr</option>
          <option value="came_online">Yalnız onlayn olanlar</option>
          <option value="went_offline">Yalnız oflayn olanlar</option>
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {isLoading ? emptyBox('Yüklənir…')
          : items.length === 0 ? emptyBox('Hələ heç bir hadisə qeydə alınmayıb.')
          : items.map(e => <EventRow key={e.id} e={e} device={deviceMap[e.device_id]} />)}
      </div>
      <Pagination page={page} totalPages={totalPages} setPage={setPage} />
    </>
  )
}

function SyslogTab() {
  const [page, setPage] = useState(1)
  const [maxSeverity, setMaxSeverity] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['syslog', page, maxSeverity, q],
    queryFn: () => fetchSyslog(page, PAGE_SIZE, { maxSeverity: maxSeverity ?? undefined, q: q || undefined }),
    refetchInterval: 15_000,
  })
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d]))

  const items = data?.items ?? []
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>Syslog</h2>
          {data && <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>{data.total} mesaj</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <form onSubmit={e => { e.preventDefault(); setQ(search); setPage(1) }} style={{ display: 'flex', gap: 6 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="mesajda axtar…"
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', width: 180 }} />
            <button type="submit" style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Axtar</button>
          </form>
          <select value={maxSeverity == null ? 'all' : String(maxSeverity)}
            onChange={e => { setMaxSeverity(e.target.value === 'all' ? null : Number(e.target.value)); setPage(1) }}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}>
            <option value="all">Bütün səviyyələr</option>
            <option value="3">≤ err</option>
            <option value="4">≤ warning</option>
            <option value="6">≤ info</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {isLoading ? emptyBox('Yüklənir…')
          : items.length === 0 ? emptyBox('Hələ syslog mesajı yoxdur.')
          : items.map(m => <SyslogRow key={m.id} m={m} device={m.device_id ? deviceMap[m.device_id] : undefined} />)}
      </div>
      <Pagination page={page} totalPages={totalPages} setPage={setPage} />
    </>
  )
}

function TrapsTab() {
  const [page, setPage] = useState(1)
  const [maxSeverity, setMaxSeverity] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['snmp-traps', page, maxSeverity, q],
    queryFn: () => fetchSnmpTraps(page, PAGE_SIZE, { maxSeverity: maxSeverity ?? undefined, q: q || undefined }),
    refetchInterval: 15_000,
  })
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d]))

  const items = data?.items ?? []
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>SNMP Trap</h2>
          {data && <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>{data.total} trap (linkDown / linkUp / coldStart / auth failure …)</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <form onSubmit={e => { e.preventDefault(); setQ(search); setPage(1) }} style={{ display: 'flex', gap: 6 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="trap axtar…"
              style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', width: 180 }} />
            <button type="submit" style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>Axtar</button>
          </form>
          <select value={maxSeverity == null ? 'all' : String(maxSeverity)}
            onChange={e => { setMaxSeverity(e.target.value === 'all' ? null : Number(e.target.value)); setPage(1) }}
            style={{ padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: '#fff', cursor: 'pointer' }}>
            <option value="all">Bütün səviyyələr</option>
            <option value="3">≤ err</option>
            <option value="4">≤ warning</option>
            <option value="6">≤ info</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {isLoading ? emptyBox('Yüklənir…')
          : items.length === 0 ? emptyBox('Hələ SNMP trap qeydə alınmayıb.')
          : items.map(t => <TrapRow key={t.id} t={t} device={t.device_id ? deviceMap[t.device_id] : undefined} />)}
      </div>
      <Pagination page={page} totalPages={totalPages} setPage={setPage} />
    </>
  )
}

// ── Page 2: one device at a time (+ its editable description note) ─────────────
function DeviceLogsPage() {
  const { hasPermission, isManager } = useAuth()
  const canEdit = hasPermission('edit_device') || isManager
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const [deviceId, setDeviceId] = useState<string>('')

  const device = devices.find(d => d.id === deviceId)

  const { data: eventsData } = useQuery({
    queryKey: ['events', 'device', deviceId],
    queryFn: () => fetchEvents(1, PAGE_SIZE, deviceId),
    enabled: !!deviceId,
  })
  const { data: syslogData } = useQuery({
    queryKey: ['syslog', 'device', deviceId],
    queryFn: () => fetchSyslog(1, PAGE_SIZE, { deviceId }),
    enabled: !!deviceId,
  })
  const { data: trapData } = useQuery({
    queryKey: ['snmp-traps', 'device', deviceId],
    queryFn: () => fetchSnmpTraps(1, PAGE_SIZE, { deviceId }),
    enabled: !!deviceId,
  })

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>Cihaz seçin</label>
        <select value={deviceId} onChange={e => setDeviceId(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', background: '#fff', cursor: 'pointer', minWidth: 320 }}>
          <option value="">— cihaz seçin —</option>
          {[...devices].sort((a, b) => a.vendor_name.localeCompare(b.vendor_name)).map(d => (
            <option key={d.id} value={d.id}>{d.vendor_name} · {d.ip_address}</option>
          ))}
        </select>
      </div>

      {!device ? emptyBox('Loglarını görmək üçün yuxarıdan bir cihaz seçin.') : (
        <>
          <DescriptionEditor device={device} canEdit={canEdit} />

          <h3 style={{ margin: '20px 0 10px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>Status hadisələri</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(eventsData?.items.length ?? 0) === 0 ? emptyBox('Bu cihaz üçün hadisə yoxdur.')
              : eventsData!.items.map(e => <EventRow key={e.id} e={e} device={device} />)}
          </div>

          <h3 style={{ margin: '20px 0 10px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>Syslog</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(syslogData?.items.length ?? 0) === 0 ? emptyBox('Bu cihaz üçün syslog mesajı yoxdur.')
              : syslogData!.items.map(m => <SyslogRow key={m.id} m={m} device={device} />)}
          </div>

          <h3 style={{ margin: '20px 0 10px', fontSize: 15, fontWeight: 700, color: '#1e293b' }}>SNMP Trap</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(trapData?.items.length ?? 0) === 0 ? emptyBox('Bu cihaz üçün SNMP trap yoxdur.')
              : trapData!.items.map(t => <TrapRow key={t.id} t={t} device={device} />)}
          </div>
        </>
      )}
    </>
  )
}

// Per-device custom note, saved into the device's `description` field.
function DescriptionEditor({ device, canEdit }: { device: Device; canEdit: boolean }) {
  const qc = useQueryClient()
  const [text, setText] = useState(device.description ?? '')
  useEffect(() => { setText(device.description ?? '') }, [device.id, device.description])

  const saveM = useMutation({
    mutationFn: (description: string) => devicesApi.update(device.id, { description }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })
  const dirty = text !== (device.description ?? '')

  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        Xüsusi qeyd (təsvir)
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={!canEdit}
        placeholder={canEdit ? 'Bu cihaz haqqında qeydlərinizi yazın…' : 'Qeyd yoxdur'}
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 14, fontFamily: 'inherit', resize: 'vertical', background: canEdit ? '#fff' : '#f8fafc', color: '#1e293b' }}
      />
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            onClick={() => saveM.mutate(text)}
            disabled={!dirty || saveM.isPending}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none', cursor: dirty ? 'pointer' : 'default',
              background: dirty ? '#1e40af' : '#cbd5e1', color: '#fff', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              opacity: saveM.isPending ? 0.6 : 1,
            }}>
            {saveM.isPending ? 'Yadda saxlanılır…' : 'Yadda saxla'}
          </button>
          {saveM.isSuccess && !dirty && <span style={{ fontSize: 12, color: '#16a34a' }}>✓ Saxlanıldı</span>}
        </div>
      )}
    </div>
  )
}
