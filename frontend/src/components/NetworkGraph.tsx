import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  MarkerType,
  type Edge,
  type Connection,
  type NodeChange,
} from '@xyflow/react'
import { DeviceNode, type DeviceNodeType } from './DeviceNode'
import { deviceLinksApi } from '../api/deviceLinks'
import { useAuth } from '../hooks/useAuth'
import type { Device, DeviceLink, DeviceLinkKind } from '../types'

const nodeTypes = { deviceNode: DeviceNode }

const COLS = 5
const COL_W = 220
const ROW_H = 170

// Manual-link palette: physical = solid teal cabling, logical = dashed violet.
const KIND_STYLE: Record<DeviceLinkKind, { color: string; dash?: string; az: string }> = {
  physical: { color: '#0d9488', az: 'Fiziki' },
  logical: { color: '#8b5cf6', dash: '5 5', az: 'Məntiqi' },
}

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

// ── Edge builders ────────────────────────────────────────────────────────────
function dependencyEdge(d: Device): Edge {
  const down = d.current_status === 'offline'
  const color = down ? '#ef4444' : '#94a3b8'
  return {
    id: `dep-${d.id}`,
    source: d.parent_id!,
    target: d.id,
    animated: down,
    deletable: false,
    selectable: false,
    style: { stroke: color, strokeWidth: down ? 2 : 1.5, strokeDasharray: down ? '6 6' : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  }
}

function manualEdge(link: DeviceLink): Edge {
  const s = KIND_STYLE[link.kind] ?? KIND_STYLE.physical
  return {
    id: `dlink-${link.id}`,
    source: link.source_id,
    target: link.target_id,
    label: link.label ?? undefined,
    deletable: true,
    style: { stroke: s.color, strokeWidth: 2.2, strokeDasharray: s.dash },
    labelStyle: { fill: s.color, fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
  }
}

function buildEdges(devices: Device[], links: DeviceLink[]): Edge[] {
  const ids = new Set(devices.map(d => d.id))
  const deps = devices
    .filter(d => d.parent_id && ids.has(d.parent_id))
    .map(dependencyEdge)
  const manual = links
    .filter(l => ids.has(l.source_id) && ids.has(l.target_id))
    .map(manualEdge)
  return [...deps, ...manual]
}

interface Props {
  devices: Device[]
  selectedId: string | null
  onSelect: (device: Device) => void
}

export function NetworkGraph({ devices, selectedId, onSelect }: Props) {
  const qc = useQueryClient()
  const { hasPermission, isManager } = useAuth()
  const canEdit = hasPermission('edit_device') || isManager

  const savedPos = useRef(loadPositions())
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceNodeType>(
    devices.map((d, i) => ({ ...toNode(d, i, savedPos.current), deletable: false })),
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [kind, setKind] = useState<DeviceLinkKind>('physical')

  const { data: links = [] } = useQuery({
    queryKey: ['device-links'],
    queryFn: deviceLinksApi.list,
    refetchInterval: 60_000,
  })

  const createM = useMutation({
    mutationFn: deviceLinksApi.create,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-links'] }),
  })
  const removeM = useMutation({
    mutationFn: deviceLinksApi.remove,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-links'] }),
  })

  // Keep node data in sync with the live device list (status + new devices).
  useEffect(() => {
    setNodes(prev => {
      const prevMap = Object.fromEntries(prev.map(n => [n.id, n]))
      return devices.map((device, i) => ({
        ...(prevMap[device.id] ?? toNode(device, i, savedPos.current)),
        data: { device },
        selected: device.id === selectedId,
        deletable: false,
      }))
    })
  }, [devices, selectedId, setNodes])

  // Rebuild edges whenever devices or manual links change.
  useEffect(() => {
    setEdges(buildEdges(devices, links))
  }, [devices, links, setEdges])

  const handleNodesChange = useCallback(
    (changes: NodeChange<DeviceNodeType>[]) => {
      onNodesChange(changes)
      const dragEnded = changes.some(c => c.type === 'position' && c.dragging === false)
      if (dragEnded) setNodes(prev => { savePositions(prev); return prev })
    },
    [onNodesChange, setNodes],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target || c.source === c.target) return
      createM.mutate({ source_id: c.source, target_id: c.target, kind })
    },
    [canEdit, kind, createM],
  )

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!canEdit) return
      deleted.forEach(e => {
        if (e.id.startsWith('dlink-')) removeM.mutate(e.id.slice('dlink-'.length))
      })
    },
    [canEdit, removeM],
  )

  const manualCount = useMemo(() => edges.filter(e => e.id.startsWith('dlink-')).length, [edges])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={(_, node) => onSelect(node.data.device)}
        nodeTypes={nodeTypes}
        nodesConnectable={canEdit}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
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

      {/* Manual-mapping toolbar */}
      <div
        style={{
          position: 'absolute', top: 12, left: 12, zIndex: 5,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
          boxShadow: '0 2px 10px rgba(0,0,0,0.08)', padding: 10, width: 210,
          fontFamily: 'inherit',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', marginBottom: 6, letterSpacing: '0.03em' }}>
          Şəbəkə xəritələmə
        </div>
        {canEdit ? (
          <>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>Yeni bağlantı tipi:</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(Object.keys(KIND_STYLE) as DeviceLinkKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  style={{
                    flex: 1, padding: '5px 6px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                    borderRadius: 6, fontFamily: 'inherit',
                    border: '1px solid ' + (kind === k ? KIND_STYLE[k].color : '#e2e8f0'),
                    background: kind === k ? KIND_STYLE[k].color : '#fff',
                    color: kind === k ? '#fff' : '#475569',
                  }}
                >
                  {KIND_STYLE[k].az}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.5 }}>
              Bir cihazın alt nöqtəsindən başqa cihaza sürüşdürüb birləşdir. Xətti silmək üçün seç → Delete.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.5 }}>
            Bağlantıları redaktə etmək üçün <b>edit_device</b> icazəsi lazımdır.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9', fontSize: 10.5, color: '#64748b' }}>
          <LegendRow color={KIND_STYLE.physical.color} label="Fiziki bağlantı" />
          <LegendRow color={KIND_STYLE.logical.color} label="Məntiqi bağlantı" dashed />
          <LegendRow color="#94a3b8" label="Asılılıq (valideyn)" arrow />
          <div style={{ marginTop: 2, color: '#94a3b8' }}>{manualCount} manual bağlantı</div>
        </div>
      </div>
    </div>
  )
}

function LegendRow({ color, label, dashed, arrow }: { color: string; label: string; dashed?: boolean; arrow?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <svg width={22} height={8}>
        <line x1={0} y1={4} x2={arrow ? 16 : 22} y2={4} stroke={color} strokeWidth={2} strokeDasharray={dashed ? '4 3' : undefined} />
        {arrow && <polygon points="16,1 22,4 16,7" fill={color} />}
      </svg>
      <span>{label}</span>
    </div>
  )
}
