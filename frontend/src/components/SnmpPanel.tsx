import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import type { Device, SnmpFacts, SnmpHistoryPoint } from '../types'

// SNMP telemetry panel for the device drawer: system info, CPU/memory gauges,
// per-interface status + traffic rates, and a metric history chart backed by
// the snmp_history hypertable.

const SNMP_STATUS: Record<string, { label: string; color: string }> = {
  ok:      { label: 'OK',          color: '#16a34a' },
  timeout: { label: 'Cavab vermir', color: '#ef4444' },
  error:   { label: 'Xəta',        color: '#f59e0b' },
  unknown: { label: 'Yoxlanmayıb', color: '#94a3b8' },
}

export function formatBps(bps: number | null | undefined): string {
  if (bps == null) return '—'
  if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' Gb/s'
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mb/s'
  if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' kb/s'
  return Math.round(bps) + ' b/s'
}

function Gauge({ label, value }: { label: string; value: number | null | undefined }) {
  const pct = value != null ? Math.min(100, Math.max(0, value)) : null
  const color = pct == null ? '#cbd5e1' : pct >= 90 ? '#ef4444' : pct >= 70 ? '#eab308' : '#16a34a'
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: '#64748b' }}>{label}</span>
        <span style={{ fontWeight: 700, color: pct == null ? '#94a3b8' : '#0f172a' }}>
          {pct == null ? '—' : `${pct}%`}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: '#e2e8f0', overflow: 'hidden' }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: color, transition: 'width 0.4s' }} />
      </div>
    </div>
  )
}

// ── Metric history chart (CPU % / MEM % / traffic bps) ──────────────────────
const RANGES = [
  { key: '1h', label: '1s' },
  { key: '24h', label: '24s' },
  { key: '7d', label: '7g' },
] as const
const METRICS = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'RAM' },
  { key: 'traffic', label: 'Trafik' },
] as const
type MetricKey = (typeof METRICS)[number]['key']

const W = 300
const H = 80
const PAD = 4

function seriesFor(points: SnmpHistoryPoint[], metric: MetricKey): (number | null)[][] {
  if (metric === 'cpu') return [points.map(p => p.cpu_percent)]
  if (metric === 'mem') return [points.map(p => p.mem_percent)]
  return [points.map(p => p.in_bps), points.map(p => p.out_bps)]
}

const SERIES_COLORS = ['#0f766e', '#b45309']

function SnmpChart({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<string>('1h')
  const [metric, setMetric] = useState<MetricKey>('traffic')

  const { data: points = [] } = useQuery({
    queryKey: ['device-snmp-history', deviceId, range],
    queryFn: () => devicesApi.snmpHistory(deviceId, range),
    refetchInterval: 30_000,
  })

  const series = useMemo(() => seriesFor(points, metric), [points, metric])
  const flat = series.flat().filter((v): v is number => v != null)
  const max = metric === 'traffic' ? (flat.length ? Math.max(...flat) : 1) : 100
  const span = max || 1
  const n = points.length
  const x = (i: number) => PAD + (n <= 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD))
  const y = (v: number) => PAD + (1 - v / span) * (H - 2 * PAD)

  const paths = series.map(vals => {
    let d = ''
    vals.forEach((v, i) => {
      if (v == null) return
      d += (d && vals[i - 1] != null ? ' L ' : ' M ') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)
    })
    return d.trim()
  })

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {METRICS.map(m => (
            <button key={m.key} onClick={() => setMetric(m.key)}
              style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid ' + (metric === m.key ? '#0f766e' : '#e2e8f0'),
                background: metric === m.key ? '#0f766e' : '#fff',
                color: metric === m.key ? '#fff' : '#475569',
              }}>
              {m.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button key={r.key} onClick={() => setRange(r.key)}
              style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid ' + (range === r.key ? '#0f766e' : '#e2e8f0'),
                background: range === r.key ? '#0f766e' : '#fff',
                color: range === r.key ? '#fff' : '#475569',
              }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {points.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>Hələ tarixçə yoxdur.</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', background: '#f8fafc', borderRadius: 6 }}>
            {paths.map((d, i) => (
              <path key={i} d={d} fill="none" stroke={SERIES_COLORS[i]} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            ))}
          </svg>
          {metric === 'traffic' && (
            <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: '#475569' }}>
              <span><span style={{ color: SERIES_COLORS[0] }}>▬</span> daxil {formatBps(flat.length ? points[points.length - 1].in_bps : null)}</span>
              <span><span style={{ color: SERIES_COLORS[1] }}>▬</span> xaric {formatBps(flat.length ? points[points.length - 1].out_bps : null)}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────────
interface Props {
  device: Device
  canPoll: boolean
}

// Live-mode poll cadence — the on-demand snmp-check endpoint takes ~1s per
// device, 5s keeps it responsive without hammering the device.
const LIVE_INTERVAL_MS = 5_000

export function SnmpPanel({ device, canPoll }: Props) {
  const qc = useQueryClient()
  const [live, setLive] = useState(false)
  const snmpM = useMutation({
    mutationFn: (id: string) => devicesApi.snmpCheck(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); qc.invalidateQueries({ queryKey: ['device-snmp-history'] }) },
  })
  // Keep a ref so the effects below don't need snmpM in their deps (the
  // mutation object identity changes every render).
  const pollRef = useRef(snmpM.mutate)
  pollRef.current = snmpM.mutate

  // Poll immediately when a device is opened, so the panel shows the CURRENT
  // state instead of data up to one collector interval (30s) old.
  useEffect(() => {
    setLive(false)
    if (canPoll) pollRef.current(device.id)
  }, [device.id, canPoll])

  // Live mode: keep re-polling while enabled (and stop when the panel closes).
  useEffect(() => {
    if (!live || !canPoll) return
    const t = setInterval(() => pollRef.current(device.id), LIVE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [live, canPoll, device.id])

  let facts: SnmpFacts | null = null
  try { facts = device.snmp_facts ? JSON.parse(device.snmp_facts) as SnmpFacts : null } catch { /* ignore */ }
  const st = SNMP_STATUS[device.snmp_status] ?? SNMP_STATUS.unknown
  const ifaces = facts?.interfaces ?? []

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          SNMP telemetriya
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: st.color }}>● {st.label}</span>
      </div>

      <div style={{ background: '#eff6ff', border: '1px solid #dbeafe', borderRadius: 8, padding: '10px 13px', fontSize: 13 }}>
        {[
          ['Sistem adı', facts?.sys_name],
          ['Uptime', facts?.uptime],
        ].filter(([, v]) => v).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ color: '#64748b' }}>{k}</span>
            <span style={{ color: '#0f172a', fontWeight: 500, fontFamily: 'monospace', textAlign: 'right', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
          </div>
        ))}
        {facts?.sys_descr && (
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={facts.sys_descr}>
            {facts.sys_descr}
          </div>
        )}

        {(facts?.cpu_percent != null || facts?.mem_percent != null) && (
          <div style={{ display: 'flex', gap: 12, marginTop: 4, marginBottom: 6 }}>
            <Gauge label="CPU" value={facts?.cpu_percent} />
            <Gauge label="RAM" value={facts?.mem_percent} />
          </div>
        )}

        {ifaces.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ color: '#64748b', marginBottom: 4 }}>İnterfeyslər</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '3px 8px', fontFamily: 'monospace', fontSize: 11, alignItems: 'center' }}>
              <span style={{ color: '#94a3b8', fontFamily: 'inherit' }} />
              <span style={{ color: '#94a3b8' }}>ad</span>
              <span style={{ color: '#94a3b8', textAlign: 'right' }}>↓ daxil</span>
              <span style={{ color: '#94a3b8', textAlign: 'right' }}>↑ xaric</span>
              {ifaces.map(i => (
                <SnmpIfRow key={i.index} iface={i} />
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8' }}>
          {device.snmp_collected_at
            ? `Toplandı: ${new Date(device.snmp_collected_at).toLocaleTimeString()}`
            : 'Hələ toplanmayıb'}
        </div>
      </div>

      {canPoll && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            onClick={() => snmpM.mutate(device.id)}
            disabled={snmpM.isPending}
            style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #93c5fd', background: '#fff', color: '#1e40af', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, opacity: snmpM.isPending ? 0.6 : 1 }}
          >
            {snmpM.isPending ? 'Sorğulanır…' : '⟳ SNMP yoxla'}
          </button>
          <button
            onClick={() => setLive(v => !v)}
            style={{
              flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
              border: '1px solid ' + (live ? '#16a34a' : '#e2e8f0'),
              background: live ? '#dcfce7' : '#fff',
              color: live ? '#166534' : '#475569',
            }}
          >
            {live ? '⏸ Canlı: aktiv' : '▶ Canlı rejim (5s)'}
          </button>
        </div>
      )}

      <SnmpChart deviceId={device.id} />
    </div>
  )
}

function SnmpIfRow({ iface }: { iface: NonNullable<SnmpFacts['interfaces']>[number] }) {
  return (
    <>
      <span title={iface.oper} style={{ color: iface.oper === 'up' ? '#16a34a' : '#ef4444', fontSize: 9 }}>●</span>
      <span style={{ color: '#0f172a', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={iface.speed_mbps ? `${iface.speed_mbps} Mb/s` : undefined}>
        {iface.name}
      </span>
      <span style={{ textAlign: 'right', color: '#334155' }}>{formatBps(iface.in_bps)}</span>
      <span style={{ textAlign: 'right', color: '#334155' }}>{formatBps(iface.out_bps)}</span>
    </>
  )
}
