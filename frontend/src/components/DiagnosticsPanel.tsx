import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { devicesApi } from '../api/devices'
import type { Device, PingNowResult, TraceHop } from '../types'

// Manual diagnostics from the monitoring server: on-demand ping (per-packet
// RTTs + loss) and traceroute (hop list). Rendered in the device drawer.

export function DiagnosticsPanel({ device }: { device: Device }) {
  const [ping, setPing] = useState<PingNowResult | null>(null)
  const [trace, setTrace] = useState<TraceHop[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset results when switching devices.
  useEffect(() => { setPing(null); setTrace(null); setError(null) }, [device.id])

  const pingM = useMutation({
    mutationFn: () => devicesApi.pingNow(device.id),
    onMutate: () => { setError(null) },
    onSuccess: (r) => setPing(r),
    onError: (e: unknown) => setError(
      (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Ping alınmadı'),
  })
  const traceM = useMutation({
    mutationFn: () => devicesApi.traceroute(device.id),
    onMutate: () => { setError(null) },
    onSuccess: (r) => setTrace(r),
    onError: (e: unknown) => setError(
      (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Traceroute alınmadı'),
  })

  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #e2e8f0',
    background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 13,
    fontFamily: 'inherit', fontWeight: 600, opacity: active ? 0.6 : 1,
  })

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        Diaqnostika
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => pingM.mutate()} disabled={pingM.isPending} style={btn(pingM.isPending)}>
          {pingM.isPending ? 'Ping…' : '📡 Ping'}
        </button>
        <button onClick={() => traceM.mutate()} disabled={traceM.isPending} style={btn(traceM.isPending)}>
          {traceM.isPending ? 'İzlənir…' : '🛰 Traceroute'}
        </button>
      </div>

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{error}</div>}

      {ping && (
        <div style={{ marginTop: 8, background: '#0f172a', borderRadius: 8, padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', position: 'relative' }}>
          <button onClick={() => setPing(null)} aria-label="Bağla"
            style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}>
            ×
          </button>
          <div style={{ color: ping.alive ? '#4ade80' : '#f87171', fontWeight: 700, marginBottom: 4 }}>
            {ping.alive ? '● cavab verir' : '● cavab vermir'}
            <span style={{ color: '#94a3b8', fontWeight: 400 }}> — {device.ip_address}</span>
          </div>
          {ping.rtts_ms.map((r, i) => (
            <div key={i}>seq={i + 1}  time={r} ms</div>
          ))}
          <div style={{ marginTop: 4, color: '#94a3b8' }}>
            {ping.packets_received}/{ping.packets_sent} paket, itki {ping.packet_loss_pct}%
            {ping.avg_ms != null && <> · min/orta/maks {ping.min_ms}/{ping.avg_ms}/{ping.max_ms} ms</>}
          </div>
        </div>
      )}

      {trace && (
        <div style={{ marginTop: 8, background: '#0f172a', borderRadius: 8, padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', position: 'relative' }}>
          <button onClick={() => setTrace(null)} aria-label="Bağla"
            style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 2 }}>
            ×
          </button>
          <div style={{ color: '#94a3b8', marginBottom: 4 }}>traceroute → {device.ip_address}</div>
          {trace.length === 0 ? (
            <div style={{ color: '#f87171' }}>hop tapılmadı</div>
          ) : trace.map(h => (
            <div key={h.distance}>
              <span style={{ color: '#64748b' }}>{String(h.distance).padStart(2)} </span>
              {h.address ?? '*'}
              {h.rtt_ms != null && <span style={{ color: '#94a3b8' }}>  {h.rtt_ms} ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
