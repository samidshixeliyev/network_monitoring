import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  BackgroundVariant,
  MarkerType,
  type Edge,
  type NodeChange,
} from '@xyflow/react'
import { DeviceNode, type DeviceNodeType } from './DeviceNode'
import type { Device } from '../types'

const nodeTypes = { deviceNode: DeviceNode }

const COLS = 5
const COL_W = 220
const ROW_H = 170

function gridPos(i: number) {
  return { x: (i % COLS) * COL_W + 40, y: Math.floor(i / COLS) * ROW_H + 40 }
}

function loadPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem('nm-node-pos') || '{}') }
  catch { return {} }
}

function savePositions(nodes: DeviceNodeType[]) {
  const pos: Record<string, { x: number; y: number }> = {}
  nodes.forEach(n => { pos[n.id] = n.position })
  localStorage.setItem('nm-node-pos', JSON.stringify(pos))
}

function toNode(device: Device, idx: number, saved: Record<string, { x: number; y: number }>): DeviceNodeType {
  return {
    id: device.id,
    type: 'deviceNode',
    position: saved[device.id] ?? gridPos(idx),
    data: { device },
  }
}

interface Props {
  devices: Device[]
  selectedId: string | null
  onSelect: (device: Device) => void
}

export function NetworkGraph({ devices, selectedId, onSelect }: Props) {
  const savedPos = useRef(loadPositions())
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceNodeType>(
    devices.map((d, i) => toNode(d, i, savedPos.current)),
  )

  // Keep node data in sync with live device list (status changes + new devices)
  useEffect(() => {
    setNodes(prev => {
      const prevMap = Object.fromEntries(prev.map(n => [n.id, n]))
      return devices.map((device, i) => ({
        ...(prevMap[device.id] ?? toNode(device, i, savedPos.current)),
        data: { device },
        selected: device.id === selectedId,
      }))
    })
  }, [devices, selectedId, setNodes])

  // Topology edges from parent_id (parent → child). An edge to a device that
  // is filtered out of the current list is skipped rather than left dangling.
  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(devices.map(d => d.id))
    return devices
      .filter(d => d.parent_id && ids.has(d.parent_id))
      .map(d => {
        const down = d.current_status === 'offline'
        const color = down ? '#ef4444' : '#94a3b8'
        return {
          id: `link-${d.id}`,
          source: d.parent_id!,
          target: d.id,
          animated: down,
          style: { stroke: color, strokeWidth: down ? 2 : 1.5, strokeDasharray: down ? '6 6' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        }
      })
  }, [devices])

  const handleChange = useCallback(
    (changes: NodeChange<DeviceNodeType>[]) => {
      onNodesChange(changes)
      const dragEnded = changes.some(c => c.type === 'position' && c.dragging === false)
      if (dragEnded) {
        setNodes(prev => { savePositions(prev); return prev })
      }
    },
    [onNodesChange, setNodes],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={handleChange}
      onNodeClick={(_, node) => onSelect(node.data.device)}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={null}
      style={{ background: '#f8fafc' }}
    >
      <Background variant={BackgroundVariant.Dots} color="#cbd5e1" gap={24} size={1} />
      <Controls showInteractive={false} style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.08)', border: '1px solid #e2e8f0', borderRadius: 8 }} />
      <MiniMap
        nodeColor={n => {
          const status = (n as DeviceNodeType).data?.device?.current_status
          return status === 'online' ? '#16a34a' : status === 'offline' ? '#ef4444' : '#eab308'
        }}
        maskColor="rgba(248,250,252,0.8)"
        style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 }}
      />
    </ReactFlow>
  )
}
