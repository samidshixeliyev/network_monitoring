import { useQuery } from '@tanstack/react-query'
import { fetchHeartbeat } from '../api/sla'

/** Self-monitoring: shows whether the collector's last probe cycle is recent.
 * Green = healthy, red = stuck/down — so users can distinguish "all healthy"
 * from "the monitor itself stopped". */
export function HeartbeatBadge() {
  const { data } = useQuery({
    queryKey: ['heartbeat'],
    queryFn: fetchHeartbeat,
    refetchInterval: 15_000,
  })

  const healthy = data?.healthy ?? false
  const age = data?.age_seconds
  const title = data?.heartbeat
    ? `Son probe tsikli ${age != null ? Math.round(age) + 's əvvəl' : '—'}`
    : 'Kollektordan siqnal yoxdur'

  return (
    <div title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#cbd5e1' }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: healthy ? '#22c55e' : '#ef4444',
        boxShadow: `0 0 6px ${healthy ? '#22c55e' : '#ef4444'}`,
      }} />
      monitor
    </div>
  )
}
