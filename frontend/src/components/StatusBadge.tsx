import type { DeviceStatus } from '../types'

const cfg: Record<DeviceStatus, { label: string; dot: string; bg: string; text: string }> = {
  online:  { label: 'Online',  dot: '#16a34a', bg: '#dcfce7', text: '#166534' },
  offline: { label: 'Offline', dot: '#dc2626', bg: '#fee2e2', text: '#991b1b' },
  unknown: { label: 'Unknown', dot: '#eab308', bg: '#fef9c3', text: '#854d0e' },
}

export function StatusBadge({ status }: { status: DeviceStatus }) {
  const { label, dot, bg, text } = cfg[status]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        color: text,
        background: bg,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      {label}
    </span>
  )
}
