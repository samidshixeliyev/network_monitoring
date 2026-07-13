import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { fetchSnmpTraps } from '../api/snmpTraps'
import { formatBytes } from '../lib/format'
import { TrafficModal } from './TrafficModal'
import type {
  Device, SnmpInventory, SnmpInvInterface, SnmpInvSensor, SnmpTrap,
} from '../types'

// Futuristic full-device SNMP explorer. One on-demand comprehensive walk
// (POST /snmp-inventory — persists nothing) drives a neon, category-tabbed
// console: system identity, sensors, resources (CPU/RAM/disk), rich interfaces
// (errors/discards), L2 (VLAN/MAC), L3 (ARP/routing), QoS/VPN/wireless and this
// device's recent SNMP traps. Vendor-only categories that a device doesn't
// answer render an empty-state instead of failing the whole view.

interface Props {
  device: Device
  onClose: () => void
}

// Shared neon palette (matches TrafficModal).
const CY = '#22d3ee'
const MG = '#f472b6'
const OK = '#34d399'
const WARN = '#f59e0b'
const BAD = '#f43f5e'

const CATS = [
  { key: 'system', label: 'Sistem', icon: '▤' },
  { key: 'sensors', label: 'Sensorlar', icon: '🌡' },
  { key: 'resources', label: 'Resurslar', icon: '▥' },
  { key: 'interfaces', label: 'İnterfeyslər', icon: '⇄' },
  { key: 'l2', label: 'L2 · VLAN/MAC', icon: '▦' },
  { key: 'l3', label: 'L3 · ARP/Route', icon: '⊹' },
  { key: 'services', label: 'QoS/VPN/WiFi', icon: '✦' },
  { key: 'traps', label: 'Traplar', icon: '⚑' },
] as const
type CatKey = (typeof CATS)[number]['key']

const SEV_COLOR = ['#7f1d1d', '#b91c1c', '#dc2626', '#ea580c', '#d97706', '#0284c7', '#64748b', '#94a3b8']
const SEV_LABEL = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']

export function SnmpExplorerModal({ device, onClose }: Props) {
  const [cat, setCat] = useState<CatKey>('system')
  const [showTraffic, setShowTraffic] = useState(false)

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['snmp-inventory', device.id],
    queryFn: () => devicesApi.snmpInventory(device.id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const inv = data?.data ?? null

  const traps = useQuery({
    queryKey: ['snmp-traps', 'device', device.id],
    queryFn: () => fetchSnmpTraps(1, 50, { deviceId: device.id }),
    refetchInterval: 15_000,
  })

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const counts: Record<CatKey, number | null> = useMemo(() => ({
    system: inv ? 1 : null,
    sensors: inv?.sensors.length ?? null,
    resources: inv ? inv.storage.length : null,
    interfaces: inv?.interfaces.length ?? null,
    l2: inv ? inv.vlans.length + inv.mac_table.length : null,
    l3: inv ? inv.arp.length + inv.routes.length : null,
    services: inv ? inv.qos.length + inv.vpn.length + inv.wireless.length : null,
    traps: traps.data?.total ?? null,
  }), [inv, traps.data])

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(2,6,23,0.74)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(1040px, 96vw)', height: 'min(680px, 92vh)',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(160deg, #0b1220 0%, #0a0e1a 100%)',
          border: '1px solid #1e293b', borderRadius: 14,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,211,238,0.06)',
          color: '#e2e8f0', overflow: 'hidden', fontFamily: 'inherit',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid #1e293b' }}>
          <span style={{ fontSize: 15, letterSpacing: '0.14em', color: CY, textShadow: `0 0 12px ${CY}66`, fontWeight: 700 }}>
            🛰 SNMP KƏŞFİYYATI
          </span>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>
            {device.vendor_name} <span style={{ fontFamily: 'monospace', color: '#64748b' }}>· {device.ip_address}</span>
          </span>
          <span style={{ flex: 1 }} />
          {inv?.system?.vendor && (
            <span style={{ fontSize: 11, color: '#67e8f9', border: '1px solid #164e63', borderRadius: 6, padding: '2px 8px' }}>{inv.system.vendor}</span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: isFetching ? '#475569' : '#cbd5e1', cursor: isFetching ? 'default' : 'pointer', fontSize: 12, fontFamily: 'inherit' }}
          >
            {isFetching ? 'Sorğulanır…' : '⟳ Yenilə'}
          </button>
          <button
            onClick={onClose}
            style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#94a3b8', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
            title="Bağla (Esc)"
          >×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Category nav */}
          <div style={{ width: 208, flexShrink: 0, borderRight: '1px solid #1e293b', overflowY: 'auto', padding: 8 }}>
            {CATS.map(c => {
              const active = c.key === cat
              const n = counts[c.key]
              const dim = n === 0
              return (
                <button
                  key={c.key}
                  onClick={() => setCat(c.key)}
                  style={{
                    width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4, cursor: 'pointer',
                    padding: '9px 11px', borderRadius: 8, fontFamily: 'inherit', fontSize: 13,
                    border: '1px solid ' + (active ? CY : '#1e293b'),
                    background: active ? 'rgba(34,211,238,0.10)' : '#0d1526',
                    boxShadow: active ? `0 0 0 1px ${CY}44, 0 0 18px ${CY}22` : 'none',
                    color: active ? '#e2e8f0' : dim ? '#475569' : '#cbd5e1',
                  }}
                >
                  <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{c.icon}</span>
                  <span style={{ flex: 1 }}>{c.label}</span>
                  {n != null && n > 0 && (
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: active ? CY : '#64748b', background: '#0b1220', borderRadius: 5, padding: '1px 6px' }}>{n}</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 18 }}>
            {error ? (
              <Empty text="SNMP sorğusu alınmadı — cihaz cavab vermir və ya SNMP konfiqurasiya olunmayıb." />
            ) : !inv ? (
              <div style={{ margin: 'auto', color: '#64748b', fontSize: 13, textAlign: 'center', paddingTop: 60 }}>
                {isFetching ? 'SNMP ağacı sorğulanır…' : 'Məlumat yoxdur.'}
              </div>
            ) : cat === 'system' ? <SystemView inv={inv} />
              : cat === 'sensors' ? <SensorsView sensors={inv.sensors} />
              : cat === 'resources' ? <ResourcesView inv={inv} />
              : cat === 'interfaces' ? <InterfacesView inv={inv} onLiveTraffic={() => setShowTraffic(true)} />
              : cat === 'l2' ? <L2View inv={inv} />
              : cat === 'l3' ? <L3View inv={inv} />
              : cat === 'services' ? <ServicesView inv={inv} />
              : <TrapsView traps={traps.data?.items ?? []} loading={traps.isLoading} />}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderTop: '1px solid #1e293b', fontSize: 11, color: '#64748b' }}>
          <span>Tam-tələbə SNMP walk · heç nə saxlanmır</span>
          <span style={{ flex: 1 }} />
          {inv?.meta?.collected_at && <span>Toplandı: {new Date(inv.meta.collected_at).toLocaleTimeString()}</span>}
        </div>
      </div>

      {showTraffic && (
        <TrafficModal device={device} canPoll onClose={() => setShowTraffic(false)} />
      )}
    </div>,
    document.body,
  )
}

// ── Shared primitives ─────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: '40px 20px', textAlign: 'center', color: '#475569', fontSize: 13, border: '1px dashed #1e293b', borderRadius: 10, background: '#0b1220' }}>
      {text}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: '0.12em', color: '#475569', textTransform: 'uppercase', margin: '2px 0 10px' }}>
      {children}
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  if (v == null || v === '') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid #111c30' }}>
      <span style={{ color: '#64748b', fontSize: 12.5 }}>{k}</span>
      <span style={{ color: '#e2e8f0', fontSize: 12.5, fontFamily: mono ? 'monospace' : 'inherit', textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  )
}

const cell: React.CSSProperties = { padding: '6px 10px', fontSize: 12, borderBottom: '1px solid #111c30', whiteSpace: 'nowrap' }
const head: React.CSSProperties = { ...cell, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, position: 'sticky', top: 0, background: '#0a0e1a' }

function Meter({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  const pct = value != null ? Math.min(100, Math.max(0, value)) : null
  const color = pct == null ? '#334155' : pct >= 90 ? BAD : pct >= 70 ? WARN : OK
  return (
    <div style={{ flex: 1, minWidth: 150, background: '#0d1526', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: '#94a3b8', fontSize: 12, letterSpacing: '0.06em' }}>{label}</span>
        <span style={{ fontWeight: 700, fontFamily: 'monospace', color: pct == null ? '#475569' : color, textShadow: pct == null ? 'none' : `0 0 10px ${color}66` }}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: '#0b1220', border: '1px solid #1e293b', overflow: 'hidden' }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: color, boxShadow: pct == null ? 'none' : `0 0 10px ${color}`, transition: 'width 0.5s' }} />
      </div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontFamily: 'monospace' }}>{sub}</div>}
    </div>
  )
}

// ── Category views ─────────────────────────────────────────────────────────────
function SystemView({ inv }: { inv: SnmpInventory }) {
  const s = inv.system
  return (
    <div>
      <SectionTitle>Kimlik</SectionTitle>
      <KV k="Sistem adı" v={s.sys_name} mono />
      <KV k="İstehsalçı" v={s.vendor} />
      <KV k="Model" v={s.model} mono />
      <KV k="Seriya nömrəsi" v={s.serial} mono />
      <KV k="Aparat versiyası" v={s.hardware_rev} mono />
      <KV k="Proqram versiyası" v={s.software_rev} mono />
      <KV k="Firmware" v={s.firmware_rev} mono />
      <KV k="İş vaxtı (uptime)" v={s.uptime} mono />
      <KV k="Əlaqə" v={s.contact} />
      <KV k="Yer" v={s.location} />
      <KV k="sysObjectID" v={s.object_id} mono />
      {s.sys_descr && (
        <div style={{ marginTop: 14 }}>
          <SectionTitle>Təsvir (sysDescr)</SectionTitle>
          <div style={{ fontSize: 12.5, color: '#cbd5e1', background: '#0d1526', border: '1px solid #1e293b', borderRadius: 8, padding: 12, lineHeight: 1.5, fontFamily: 'monospace' }}>
            {s.sys_descr}
          </div>
        </div>
      )}
    </div>
  )
}

function ResourcesView({ inv }: { inv: SnmpInventory }) {
  const r = inv.resources
  const disks = inv.storage.filter(s => s.kind === 'disk')
  const other = inv.storage.filter(s => s.kind !== 'disk')
  return (
    <div>
      <SectionTitle>CPU · Yaddaş</SectionTitle>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <Meter label="CPU" value={r.cpu_percent} sub={r.cores.length ? `${r.cores.length} nüvə` : undefined} />
        <Meter label="RAM" value={r.mem_percent} />
      </div>
      {r.cores.length > 1 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
          {r.cores.map((c, i) => (
            <span key={i} title={`core ${i}`} style={{ fontSize: 10, fontFamily: 'monospace', color: c >= 90 ? BAD : c >= 70 ? WARN : OK, border: '1px solid #1e293b', borderRadius: 5, padding: '2px 6px', background: '#0d1526' }}>{c}%</span>
          ))}
        </div>
      )}
      <SectionTitle>Disk / Saxlama</SectionTitle>
      {[...disks, ...other].length === 0 ? <Empty text="Saxlama məlumatı yoxdur." /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...disks, ...other].map((d, i) => (
            <div key={i} style={{ background: '#0d1526', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, color: '#e2e8f0' }}>
                  <span style={{ color: d.kind === 'disk' ? CY : d.kind === 'ram' ? MG : '#64748b', marginRight: 6 }}>{d.kind === 'disk' ? '💾' : d.kind === 'ram' ? '▥' : '▦'}</span>
                  {d.descr}
                </span>
                <span style={{ fontSize: 11.5, fontFamily: 'monospace', color: '#94a3b8' }}>
                  {formatBytes(d.used_bytes)} / {formatBytes(d.size_bytes)}
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: '#0b1220', border: '1px solid #1e293b', overflow: 'hidden' }}>
                <div style={{ width: `${d.pct ?? 0}%`, height: '100%', background: (d.pct ?? 0) >= 90 ? BAD : (d.pct ?? 0) >= 70 ? WARN : OK, transition: 'width 0.4s' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SensorsView({ sensors }: { sensors: SnmpInvSensor[] }) {
  if (sensors.length === 0) return <Empty text="Sensor məlumatı yoxdur (temperatur / fan / güc mənbəyi). Bu göstəricilər əsasən real avadanlıqda mövcuddur." />
  const icon = (k: string) => k === 'temperature' ? '🌡' : k === 'fan' ? '🌀' : k === 'power' ? '⚡' : '•'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
      {sensors.map((s, i) => {
        const c = s.status === 'ok' ? OK : WARN
        return (
          <div key={i} style={{ background: '#0d1526', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <span style={{ fontSize: 15 }}>{icon(s.kind)}</span>
              <span style={{ fontSize: 12, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name ?? ''}>{s.name}</span>
              <span style={{ flex: 1 }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: c, textShadow: `0 0 14px ${c}44` }}>
              {s.value != null ? s.value : '—'}<span style={{ fontSize: 12, color: '#64748b', marginLeft: 4 }}>{s.unit}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function InterfacesView({ inv, onLiveTraffic }: { inv: SnmpInventory; onLiveTraffic: () => void }) {
  const ifs = inv.interfaces
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <SectionTitle>İnterfeyslər ({ifs.length})</SectionTitle>
        <span style={{ flex: 1 }} />
        <button
          onClick={onLiveTraffic}
          style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid #0ea5b7', background: 'linear-gradient(180deg,#0f766e,#0e7490)', color: '#ecfeff' }}
        >
          ⚡ Canlı trafik
        </button>
      </div>
      {ifs.length === 0 ? <Empty text="İnterfeys məlumatı yoxdur." /> : (
        <div style={{ overflowX: 'auto', border: '1px solid #1e293b', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: 'left' }}>İnterfeys</th>
                <th style={head}>Status</th>
                <th style={head}>Sürət</th>
                <th style={head}>MTU</th>
                <th style={{ ...head, textAlign: 'left' }}>MAC</th>
                <th style={head}>Səhv (in/out)</th>
                <th style={head}>Discard (in/out)</th>
              </tr>
            </thead>
            <tbody>
              {ifs.map(i => <IfRow key={i.index} i={i} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function IfRow({ i }: { i: SnmpInvInterface }) {
  const up = i.oper === 'up'
  const errs = (i.in_errors ?? 0) + (i.out_errors ?? 0)
  return (
    <tr>
      <td style={{ ...cell, color: '#e2e8f0' }}>
        {i.name}
        {i.alias && <span style={{ color: '#475569', marginLeft: 6, fontSize: 11 }}>{i.alias}</span>}
      </td>
      <td style={{ ...cell, textAlign: 'center' }}>
        <span style={{ color: up ? OK : BAD, fontWeight: 600 }}>● {up ? 'UP' : 'DOWN'}</span>
        {i.admin === 'down' && <span style={{ color: '#64748b', fontSize: 10, marginLeft: 4 }}>(admin↓)</span>}
      </td>
      <td style={{ ...cell, textAlign: 'right', fontFamily: 'monospace', color: '#94a3b8' }}>{i.speed_mbps != null ? `${i.speed_mbps}M` : '—'}</td>
      <td style={{ ...cell, textAlign: 'right', fontFamily: 'monospace', color: '#94a3b8' }}>{i.mtu ?? '—'}</td>
      <td style={{ ...cell, fontFamily: 'monospace', color: '#64748b' }}>{i.mac ?? '—'}</td>
      <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: errs > 0 ? WARN : '#475569' }}>{i.in_errors ?? 0} / {i.out_errors ?? 0}</td>
      <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: (i.in_discards ?? 0) + (i.out_discards ?? 0) > 0 ? WARN : '#475569' }}>{i.in_discards ?? 0} / {i.out_discards ?? 0}</td>
    </tr>
  )
}

function useFilter<T>(rows: T[], pick: (r: T) => string) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? rows.filter(r => pick(r).toLowerCase().includes(s)) : rows
  }, [rows, q, pick])
  return { q, setQ, filtered }
}

function SearchBox({ q, setQ, placeholder }: { q: string; setQ: (v: string) => void; placeholder: string }) {
  return (
    <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder}
      style={{ padding: '5px 10px', border: '1px solid #1e293b', background: '#0d1526', color: '#e2e8f0', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', width: 200 }} />
  )
}

function L2View({ inv }: { inv: SnmpInventory }) {
  const mac = useFilter(inv.mac_table, m => `${m.mac} ${m.vlan ?? ''} ${m.ifindex ?? ''}`)
  return (
    <div>
      <SectionTitle>VLAN-lar ({inv.vlans.length})</SectionTitle>
      {inv.vlans.length === 0 ? <Empty text="VLAN məlumatı yoxdur (əsasən switch-lərdə mövcuddur)." /> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          {inv.vlans.map(v => (
            <span key={v.id} style={{ fontSize: 12, background: '#0d1526', border: '1px solid #1e293b', borderRadius: 6, padding: '4px 9px' }}>
              <span style={{ color: CY, fontFamily: 'monospace' }}>#{v.id}</span> <span style={{ color: '#cbd5e1' }}>{v.name}</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <SectionTitle>MAC cədvəli ({inv.mac_table.length})</SectionTitle>
        <span style={{ flex: 1 }} />
        {inv.mac_table.length > 0 && <SearchBox q={mac.q} setQ={mac.setQ} placeholder="MAC / VLAN axtar…" />}
      </div>
      {inv.mac_table.length === 0 ? <Empty text="MAC (forwarding) cədvəli yoxdur." /> : (
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #1e293b', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={{ ...head, textAlign: 'left' }}>MAC</th><th style={head}>VLAN</th><th style={head}>Port</th><th style={head}>ifIndex</th></tr></thead>
            <tbody>
              {mac.filtered.slice(0, 500).map((m, i) => (
                <tr key={i}>
                  <td style={{ ...cell, fontFamily: 'monospace', color: '#e2e8f0' }}>{m.mac}</td>
                  <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: '#94a3b8' }}>{m.vlan ?? '—'}</td>
                  <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: '#64748b' }}>{m.port ?? '—'}</td>
                  <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: '#64748b' }}>{m.ifindex ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function L3View({ inv }: { inv: SnmpInventory }) {
  const arp = useFilter(inv.arp, a => `${a.ip} ${a.mac}`)
  const rt = useFilter(inv.routes, r => `${r.dest} ${r.nexthop ?? ''}`)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <SectionTitle>ARP / qonşuluq ({inv.arp.length})</SectionTitle>
        <span style={{ flex: 1 }} />
        {inv.arp.length > 0 && <SearchBox q={arp.q} setQ={arp.setQ} placeholder="IP / MAC axtar…" />}
      </div>
      {inv.arp.length === 0 ? <Empty text="ARP cədvəli yoxdur." /> : (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #1e293b', borderRadius: 8, marginBottom: 18 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={{ ...head, textAlign: 'left' }}>IP</th><th style={{ ...head, textAlign: 'left' }}>MAC</th><th style={head}>ifIndex</th></tr></thead>
            <tbody>
              {arp.filtered.slice(0, 500).map((a, i) => (
                <tr key={i}>
                  <td style={{ ...cell, fontFamily: 'monospace', color: '#e2e8f0' }}>{a.ip}</td>
                  <td style={{ ...cell, fontFamily: 'monospace', color: '#94a3b8' }}>{a.mac}</td>
                  <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: '#64748b' }}>{a.ifindex}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <SectionTitle>Marşrutlaşdırma ({inv.routes.length})</SectionTitle>
        <span style={{ flex: 1 }} />
        {inv.routes.length > 0 && <SearchBox q={rt.q} setQ={rt.setQ} placeholder="şəbəkə / next-hop axtar…" />}
      </div>
      {inv.routes.length === 0 ? <Empty text="Marşrut cədvəli yoxdur." /> : (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #1e293b', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th style={{ ...head, textAlign: 'left' }}>Təyinat</th><th style={{ ...head, textAlign: 'left' }}>Next-hop</th><th style={head}>ifIndex</th></tr></thead>
            <tbody>
              {rt.filtered.slice(0, 500).map((r, i) => (
                <tr key={i}>
                  <td style={{ ...cell, fontFamily: 'monospace', color: '#e2e8f0' }}>{r.dest}</td>
                  <td style={{ ...cell, fontFamily: 'monospace', color: '#94a3b8' }}>{r.nexthop ?? '—'}</td>
                  <td style={{ ...cell, textAlign: 'center', fontFamily: 'monospace', color: '#64748b' }}>{r.ifindex ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ServicesView({ inv }: { inv: SnmpInventory }) {
  const empty = inv.qos.length === 0 && inv.vpn.length === 0 && inv.wireless.length === 0
  if (empty) return <Empty text="QoS / VPN / Wireless məlumatı yoxdur. Bu göstəricilər satıcıya xas MIB-lərdən gəlir (əsasən Cisco/Juniper avadanlığında)." />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionTitle>QoS ({inv.qos.length})</SectionTitle>
        {inv.qos.length === 0 ? <Empty text="QoS siyasəti yoxdur." /> : inv.qos.map((q, i) => (
          <KV key={i} k={q.kind} v={q.name} mono />
        ))}
      </div>
      <div>
        <SectionTitle>VPN / tunellər ({inv.vpn.length})</SectionTitle>
        {inv.vpn.length === 0 ? <Empty text="VPN tuneli yoxdur." /> : inv.vpn.map((v, i) => (
          <KV key={i} k={v.peer ?? 'peer'} v={<span style={{ color: v.status === 'active' ? OK : '#64748b' }}>{v.status}</span>} mono />
        ))}
      </div>
      <div>
        <SectionTitle>Wireless / AP ({inv.wireless.length})</SectionTitle>
        {inv.wireless.length === 0 ? <Empty text="Access point məlumatı yoxdur." /> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {inv.wireless.map((w, i) => (
              <span key={i} style={{ fontSize: 12, background: '#0d1526', border: '1px solid #1e293b', borderRadius: 6, padding: '4px 9px', color: '#cbd5e1' }}>📶 {w.name}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TrapsView({ traps, loading }: { traps: SnmpTrap[]; loading: boolean }) {
  if (loading) return <div style={{ color: '#64748b', fontSize: 13, paddingTop: 40, textAlign: 'center' }}>Yüklənir…</div>
  if (traps.length === 0) return <Empty text="Bu cihazdan hələ SNMP trap gəlməyib. Cihazı `snmp-server host <monitor> traps` / `trap2sink` ilə konfiqurasiya edin." />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {traps.map(t => {
        const c = SEV_COLOR[t.severity] ?? '#64748b'
        return (
          <div key={t.id} style={{ background: '#0d1526', border: '1px solid #1e293b', borderLeft: `3px solid ${c}`, borderRadius: 8, padding: '9px 12px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: c, borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase', flexShrink: 0 }}>
              {SEV_LABEL[t.severity] ?? t.severity}
            </span>
            <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, flexShrink: 0 }}>{t.trap_name}</span>
            <span style={{ fontSize: 12, color: '#94a3b8', flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{t.message}</span>
            <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace', flexShrink: 0 }}>{new Date(t.ts).toLocaleString()}</span>
          </div>
        )
      })}
    </div>
  )
}
