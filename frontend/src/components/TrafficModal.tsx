import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import { formatBps } from '../lib/format'
import { useBackdropClose } from '../lib/useBackdropClose'
import type { Device, SnmpFacts, SnmpInterface } from '../types'

// Futuristic per-port traffic monitor. Opens in a medium modal. Per-interface
// history isn't persisted server-side (snmp_history is device-level), so this
// accumulates a LIVE ring buffer per interface while the modal is open — pick a
// port on the left, watch its in/out throughput stream in real time.

interface Props {
  device: Device
  canPoll: boolean
  onClose: () => void
}

// Target one sample per second. The loop is self-chaining (fires the next poll
// only after the previous returns) so a slow device just streams as fast as it
// can instead of piling up overlapping requests; a fast one is paced to ~1s.
const TARGET_MS = 1_000
const MAX_POINTS = 120 // ~2 min of per-second history

type Sample = { t: number; inBps: number | null; outBps: number | null }

// Neon accents.
const IN_C = '#22d3ee'   // cyan — inbound
const OUT_C = '#f472b6'  // magenta — outbound

function parseFacts(device: Device): SnmpFacts | null {
  try { return device.snmp_facts ? (JSON.parse(device.snmp_facts) as SnmpFacts) : null } catch { return null }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function TrafficModal({ device: deviceProp, canPoll, onClose }: Props) {
  // Device metadata (name / ip) from the shared cache; interface RATES come
  // from the live loop below, not this list, so no app-wide refetch per second.
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list })
  const device = devices?.find(d => d.id === deviceProp.id) ?? deviceProp

  const [buffers, setBuffers] = useState<Record<number, Sample[]>>({})
  const [liveFacts, setLiveFacts] = useState<SnmpFacts | null>(() => parseFacts(deviceProp))
  const [lastAt, setLastAt] = useState<number | null>(null)

  const appendSamples = (list: SnmpInterface[]) => {
    const t = Date.now()
    setBuffers(prev => {
      const next: Record<number, Sample[]> = { ...prev }
      for (const i of list) {
        const arr = next[i.index] ? [...next[i.index]] : []
        arr.push({ t, inBps: i.in_bps, outBps: i.out_bps })
        if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS)
        next[i.index] = arr
      }
      return next
    })
    setLastAt(t)
  }
  const appendRef = useRef(appendSamples)
  appendRef.current = appendSamples

  // Live loop: poll the on-demand SNMP check ~1×/s and drive the buffer straight
  // from the response (which carries per-interface in/out bps). The backend
  // computes each rate over the ACTUAL elapsed time between polls, so a ~1s
  // cadence yields true per-second throughput.
  useEffect(() => {
    if (!canPoll) return
    let cancelled = false
    const loop = async () => {
      while (!cancelled) {
        const started = Date.now()
        try {
          const res = await devicesApi.snmpPeek(deviceProp.id)
          if (cancelled) break
          const f = res.facts as SnmpFacts | undefined
          if (f?.interfaces) {
            setLiveFacts(f)
            appendRef.current(f.interfaces)
          }
        } catch { /* transient SNMP hiccup — keep streaming */ }
        await sleep(Math.max(0, TARGET_MS - (Date.now() - started)))
      }
    }
    loop()
    return () => { cancelled = true }
  }, [canPoll, deviceProp.id])

  // No live-poll permission: fall back to the collector's periodic facts on the
  // cached device (advances every ~30s), appending when its timestamp moves.
  const lastStampRef = useRef<string | null>(null)
  useEffect(() => {
    if (canPoll) return
    const stamp = device.snmp_collected_at ?? null
    if (!stamp || stamp === lastStampRef.current) return
    lastStampRef.current = stamp
    const f = parseFacts(device)
    if (f) { setLiveFacts(f); if (f.interfaces) appendRef.current(f.interfaces) }
  }, [canPoll, device.snmp_collected_at, device])

  // Close on Escape.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const facts = liveFacts ?? parseFacts(device)
  const ifaces = facts?.interfaces ?? []

  const [selected, setSelected] = useState<number | null>(null)
  // Default to the busiest up interface once data arrives.
  useEffect(() => {
    if (selected != null || ifaces.length === 0) return
    const best = [...ifaces]
      .filter(i => i.oper === 'up')
      .sort((a, b) => ((b.in_bps ?? 0) + (b.out_bps ?? 0)) - ((a.in_bps ?? 0) + (a.out_bps ?? 0)))[0]
    setSelected((best ?? ifaces[0]).index)
  }, [ifaces, selected])

  const selIface = ifaces.find(i => i.index === selected) ?? null
  const buf = selected != null ? buffers[selected] ?? [] : []

  const backdrop = useBackdropClose(onClose)

  return createPortal(
    <div
      {...backdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(2,6,23,0.72)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(860px, 96vw)', height: 'min(560px, 92vh)',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(160deg, #0b1220 0%, #0a0e1a 100%)',
          border: '1px solid #1e293b', borderRadius: 14,
          boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,211,238,0.06)',
          color: '#e2e8f0', overflow: 'hidden', fontFamily: 'inherit',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid #1e293b' }}>
          <span style={{ fontSize: 15, letterSpacing: '0.14em', color: IN_C, textShadow: `0 0 12px ${IN_C}66`, fontWeight: 700 }}>
            ⌁ TRAFİK MONİTORU
          </span>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>
            {device.vendor_name} <span style={{ fontFamily: 'monospace', color: '#64748b' }}>· {device.ip_address}</span>
          </span>
          <span style={{ flex: 1 }} />
          <LiveDot on={canPoll} />
          <button
            onClick={onClose}
            style={{ marginLeft: 8, width: 30, height: 30, borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#94a3b8', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
            title="Bağla (Esc)"
          >×</button>
        </div>

        {/* System bar: SNMP sysinfo + CPU/RAM (from the same live poll) */}
        <SystemBar facts={facts} />

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Port list */}
          <div style={{ width: 244, flexShrink: 0, borderRight: '1px solid #1e293b', overflowY: 'auto', padding: 8 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.12em', color: '#475569', padding: '4px 8px 8px', textTransform: 'uppercase' }}>
              Portlar ({ifaces.length})
            </div>
            {ifaces.length === 0 && (
              <div style={{ fontSize: 12, color: '#64748b', padding: 12 }}>İnterfeys məlumatı yoxdur.</div>
            )}
            {ifaces.map(i => (
              <PortRow key={i.index} iface={i} active={i.index === selected} onClick={() => setSelected(i.index)} />
            ))}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 18 }}>
            {selIface ? (
              <PortDetail iface={selIface} buf={buf} />
            ) : (
              <div style={{ margin: 'auto', color: '#64748b', fontSize: 13 }}>Baxmaq üçün soldan bir port seçin.</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderTop: '1px solid #1e293b', fontSize: 11, color: '#64748b' }}>
          <span>{canPoll ? 'Canlı · hər saniyə (real-time)' : 'Canlı sorğu icazəniz yoxdur — 30s-lik yeniləmə'}</span>
          <span style={{ flex: 1 }} />
          <span>
            {lastAt
              ? `Son: ${new Date(lastAt).toLocaleTimeString()}`
              : device.snmp_collected_at
                ? `Toplandı: ${new Date(device.snmp_collected_at).toLocaleTimeString()}`
                : 'Hələ toplanmayıb'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function SystemBar({ facts }: { facts: SnmpFacts | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 18px', borderBottom: '1px solid #1e293b', background: 'rgba(15,23,42,0.35)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, letterSpacing: '0.12em', color: '#475569', textTransform: 'uppercase' }}>Sistem</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {facts?.sys_name || '—'}
        </div>
        <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={facts?.sys_descr ?? undefined}>
          {facts?.uptime ? `İş vaxtı: ${facts.uptime}` : (facts?.sys_descr || 'SNMP sistem məlumatı yoxdur')}
        </div>
      </div>
      <Meter label="CPU" value={facts?.cpu_percent} />
      <Meter label="RAM" value={facts?.mem_percent} />
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number | null | undefined }) {
  const pct = value != null ? Math.min(100, Math.max(0, value)) : null
  const color = pct == null ? '#334155' : pct >= 90 ? '#f43f5e' : pct >= 70 ? '#f59e0b' : '#34d399'
  return (
    <div style={{ width: 116, flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 3 }}>
        <span style={{ color: '#64748b', letterSpacing: '0.08em' }}>{label}</span>
        <span style={{ fontWeight: 700, fontFamily: 'monospace', color: pct == null ? '#475569' : color, textShadow: pct == null ? 'none' : `0 0 10px ${color}66` }}>
          {pct == null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: '#0d1526', border: '1px solid #1e293b', overflow: 'hidden' }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: color, boxShadow: pct == null ? 'none' : `0 0 10px ${color}`, transition: 'width 0.5s' }} />
      </div>
    </div>
  )
}

function LiveDot({ on }: { on: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: on ? '#34d399' : '#64748b' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? '#34d399' : '#475569', boxShadow: on ? '0 0 10px #34d399' : 'none', animation: on ? 'nmpulse 1.4s ease-in-out infinite' : 'none' }} />
      {on ? 'CANLI' : 'GÖZLƏMƏ'}
      <style>{'@keyframes nmpulse{0%,100%{opacity:1}50%{opacity:0.35}}'}</style>
    </span>
  )
}

function PortRow({ iface, active, onClick }: { iface: SnmpInterface; active: boolean; onClick: () => void }) {
  const up = iface.oper === 'up'
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', display: 'block', marginBottom: 4, cursor: 'pointer',
        padding: '8px 10px', borderRadius: 8, fontFamily: 'inherit',
        border: '1px solid ' + (active ? IN_C : '#1e293b'),
        background: active ? 'rgba(34,211,238,0.10)' : '#0d1526',
        boxShadow: active ? `0 0 0 1px ${IN_C}44, 0 0 18px ${IN_C}22` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: up ? '#34d399' : '#ef4444', boxShadow: up ? '0 0 8px #34d399' : 'none' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: active ? '#e2e8f0' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {iface.name}
        </span>
        <span style={{ flex: 1 }} />
        {iface.speed_mbps != null && (
          <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>{iface.speed_mbps}M</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10.5, fontFamily: 'monospace' }}>
        <span style={{ color: IN_C }}>↓ {formatBps(iface.in_bps)}</span>
        <span style={{ color: OUT_C }}>↑ {formatBps(iface.out_bps)}</span>
      </div>
    </button>
  )
}

function PortDetail({ iface, buf }: { iface: SnmpInterface; buf: Sample[] }) {
  const peakIn = Math.max(0, ...buf.map(s => s.inBps ?? 0))
  const peakOut = Math.max(0, ...buf.map(s => s.outBps ?? 0))
  const speedBps = iface.speed_mbps != null ? iface.speed_mbps * 1e6 : null
  const utilIn = speedBps ? Math.min(100, ((iface.in_bps ?? 0) / speedBps) * 100) : null
  const utilOut = speedBps ? Math.min(100, ((iface.out_bps ?? 0) / speedBps) * 100) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: '#f1f5f9' }}>{iface.name}</span>
        <span style={{ fontSize: 12, color: iface.oper === 'up' ? '#34d399' : '#ef4444', fontWeight: 600 }}>
          ● {iface.oper === 'up' ? 'UP' : 'DOWN'}
        </span>
        {iface.speed_mbps != null && <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>{iface.speed_mbps} Mb/s link</span>}
      </div>

      {/* Big readouts */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <Readout label="↓ DAXİL" color={IN_C} value={formatBps(iface.in_bps)} peak={peakIn} util={utilIn} />
        <Readout label="↑ XARİC" color={OUT_C} value={formatBps(iface.out_bps)} peak={peakOut} util={utilOut} />
      </div>

      {/* Live chart */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <TrafficChart buf={buf} />
      </div>
    </div>
  )
}

function Readout({ label, color, value, peak, util }: { label: string; color: string; value: string; peak: number; util: number | null }) {
  return (
    <div style={{ flex: 1, background: '#0d1526', border: '1px solid #1e293b', borderRadius: 10, padding: '10px 14px' }}>
      <div style={{ fontSize: 10, letterSpacing: '0.12em', color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'monospace', color, textShadow: `0 0 16px ${color}55`, lineHeight: 1.3 }}>
        {value}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: '#64748b', fontFamily: 'monospace' }}>
        <span>zirvə {formatBps(peak)}</span>
        {util != null && <span>· yük {util.toFixed(0)}%</span>}
      </div>
    </div>
  )
}

const CW = 560
const CH = 200
const CP = 6

function TrafficChart({ buf }: { buf: Sample[] }) {
  const { inPath, outPath, inArea, outArea, max } = useMemo(() => {
    const ins = buf.map(s => s.inBps)
    const outs = buf.map(s => s.outBps)
    const flat = [...ins, ...outs].filter((v): v is number => v != null)
    const max = flat.length ? Math.max(...flat, 1) : 1
    const n = buf.length
    const x = (i: number) => CP + (n <= 1 ? 0 : (i / (n - 1)) * (CW - 2 * CP))
    const y = (v: number) => CP + (1 - v / max) * (CH - 2 * CP)
    const line = (vals: (number | null)[]) => {
      let d = ''
      vals.forEach((v, i) => { if (v != null) d += (d ? ' L ' : 'M ') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) })
      return d
    }
    const area = (vals: (number | null)[]) => {
      const l = line(vals)
      if (!l) return ''
      let lastI = 0
      vals.forEach((v, i) => { if (v != null) lastI = i })
      return `${l} L ${x(lastI).toFixed(1)} ${(CH - CP).toFixed(1)} L ${x(0).toFixed(1)} ${(CH - CP).toFixed(1)} Z`
    }
    return { inPath: line(ins), outPath: line(outs), inArea: area(ins), outArea: area(outs), max }
  }, [buf])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#475569', marginBottom: 4, fontFamily: 'monospace' }}>
        <span>real-time · {buf.length} nöqtə</span>
        <span>tavan {formatBps(max)}</span>
      </div>
      <svg viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" style={{ flex: 1, width: '100%', background: '#070b14', borderRadius: 10, border: '1px solid #12203a' }}>
        <defs>
          <linearGradient id="nmIn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={IN_C} stopOpacity="0.35" />
            <stop offset="100%" stopColor={IN_C} stopOpacity="0" />
          </linearGradient>
          <linearGradient id="nmOut" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={OUT_C} stopOpacity="0.30" />
            <stop offset="100%" stopColor={OUT_C} stopOpacity="0" />
          </linearGradient>
          <filter id="nmGlow"><feGaussianBlur stdDeviation="1.6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {/* grid */}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1={CP} x2={CW - CP} y1={CP + f * (CH - 2 * CP)} y2={CP + f * (CH - 2 * CP)} stroke="#132038" strokeWidth={1} />
        ))}
        {buf.length <= 1 ? (
          <text x={CW / 2} y={CH / 2} textAnchor="middle" fill="#475569" fontSize={12} fontFamily="monospace">
            canlı axın yığılır…
          </text>
        ) : (
          <>
            {outArea && <path d={outArea} fill="url(#nmOut)" />}
            {inArea && <path d={inArea} fill="url(#nmIn)" />}
            {outPath && <path d={outPath} fill="none" stroke={OUT_C} strokeWidth={1.6} filter="url(#nmGlow)" strokeLinejoin="round" strokeLinecap="round" />}
            {inPath && <path d={inPath} fill="none" stroke={IN_C} strokeWidth={1.6} filter="url(#nmGlow)" strokeLinejoin="round" strokeLinecap="round" />}
          </>
        )}
      </svg>
    </div>
  )
}
