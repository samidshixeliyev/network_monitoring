import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import type { HistoryPoint } from '../types'

const RANGES = [
  { key: '1h', label: '1s' },
  { key: '24h', label: '24s' },
  { key: '7d', label: '7g' },
  { key: '30d', label: '30g' },
] as const

const W = 300
const H = 90
const PAD = 4

/** Dependency-free SVG latency trend + uptime summary for one device. */
export function LatencyChart({ deviceId }: { deviceId: string }) {
  const [range, setRange] = useState<string>('24h')

  const { data: points = [], isLoading } = useQuery({
    queryKey: ['device-history', deviceId, range],
    queryFn: () => devicesApi.history(deviceId, range),
    refetchInterval: 30_000,
  })

  const stats = useMemo(() => computeStats(points), [points])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Gecikmə / uptime
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                border: '1px solid ' + (range === r.key ? '#0f766e' : '#e2e8f0'),
                background: range === r.key ? '#0f766e' : '#fff',
                color: range === r.key ? '#fff' : '#475569', fontFamily: 'inherit',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div style={{ fontSize: 12, color: '#94a3b8', padding: '16px 0' }}>Yüklənir…</div>
      ) : points.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8', padding: '16px 0' }}>
          Hələ tarixçə yoxdur (məlumat toplanır).
        </div>
      ) : (
        <>
          <Sparkline points={points} />
          <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: '#475569' }}>
            <span>orta <b>{stats.avg ?? '—'}</b> ms</span>
            <span>maks <b>{stats.max ?? '—'}</b> ms</span>
            <span>uptime <b style={{ color: stats.uptime >= 99 ? '#16a34a' : stats.uptime >= 90 ? '#eab308' : '#ef4444' }}>{stats.uptime}%</b></span>
          </div>
        </>
      )}
    </div>
  )
}

function computeStats(points: HistoryPoint[]) {
  const rtts = points.map(p => p.avg_rtt_ms).filter((v): v is number => v != null)
  const totalSamples = points.reduce((s, p) => s + p.samples, 0)
  const upWeighted = points.reduce((s, p) => s + (p.uptime_pct / 100) * p.samples, 0)
  return {
    avg: rtts.length ? +(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(2) : null,
    max: rtts.length ? +Math.max(...rtts).toFixed(2) : null,
    uptime: totalSamples ? +((upWeighted / totalSamples) * 100).toFixed(1) : 0,
  }
}

function Sparkline({ points }: { points: HistoryPoint[] }) {
  const rtts = points.map(p => p.avg_rtt_ms)
  const known = rtts.filter((v): v is number => v != null)
  const max = known.length ? Math.max(...known) : 1
  const min = 0
  const span = max - min || 1
  const n = points.length

  const x = (i: number) => PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD))
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD)

  // Build the rtt path, breaking the line at gaps (null = no reply / down).
  let d = ''
  rtts.forEach((v, i) => {
    if (v == null) { d += '' ; return }
    d += (d && rtts[i - 1] != null ? ' L ' : ' M ') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', background: '#f8fafc', borderRadius: 6 }}>
      {/* downtime markers: red ticks where a bucket had any failure */}
      {points.map((p, i) =>
        p.uptime_pct < 100 ? (
          <rect key={i} x={x(i) - 1} y={PAD} width={2} height={H - 2 * PAD} fill="#ef4444" opacity={0.18} />
        ) : null,
      )}
      <path d={d.trim()} fill="none" stroke="#0f766e" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
