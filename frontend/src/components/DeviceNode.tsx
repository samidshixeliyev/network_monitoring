import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { Device } from '../types'

const STATUS_STYLE = {
  online:  { stripe: '#16a34a', dot: '#16a34a', label: 'Online',  labelColor: '#16a34a' },
  offline: { stripe: '#ef4444', dot: '#ef4444', label: 'Offline', labelColor: '#ef4444' },
  unknown: { stripe: '#eab308', dot: '#eab308', label: 'Unknown', labelColor: '#a16207' },
}

export type DeviceNodeData = { device: Device }
export type DeviceNodeType = Node<DeviceNodeData, 'deviceNode'>

export function DeviceNode({ data, selected }: NodeProps<DeviceNodeType>) {
  const { device } = data
  const s = STATUS_STYLE[device.current_status]

  return (
    <div
      style={{
        width: 192,
        background: '#fff',
        borderRadius: 10,
        border: `1.5px solid ${selected ? '#3b82f6' : '#e2e8f0'}`,
        boxShadow: selected
          ? '0 0 0 3px rgba(59,130,246,0.2), 0 8px 24px rgba(0,0,0,0.12)'
          : '0 2px 10px rgba(0,0,0,0.08)',
        overflow: 'hidden',
        cursor: 'pointer',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Status stripe */}
      <div style={{ height: 3, background: s.stripe }} />

      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />

      <div style={{ padding: '10px 12px' }}>
        {/* Name row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: s.dot, flexShrink: 0,
              boxShadow: device.current_status === 'online' ? `0 0 0 3px ${s.dot}25` : 'none',
            }}
          />
          <span
            style={{
              fontWeight: 700, fontSize: 13, color: '#1e293b',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {device.vendor_name}
          </span>
        </div>

        {/* IP */}
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', marginBottom: 3 }}>
          {device.ip_address}
        </div>

        {/* Model */}
        {device.model_name && (
          <div style={{ fontSize: 11, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {device.model_name}
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            marginTop: 8, paddingTop: 7, borderTop: '1px solid #f1f5f9',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: s.labelColor }}>{s.label}</span>
          <span style={{ fontSize: 10, color: '#cbd5e1' }}>
            {device.last_checked_at
              ? new Date(device.last_checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : '—'}
          </span>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}
