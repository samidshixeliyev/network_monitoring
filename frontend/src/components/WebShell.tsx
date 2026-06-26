import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '../hooks/useAuth'
import type { Device } from '../types'

interface Props {
  device: Device
  onClose: () => void
}

/**
 * Browser SSH terminal: an xterm.js terminal bridged over a WebSocket to an
 * interactive SSH shell on the device (backend /ws/devices/{id}/shell).
 */
export function WebShell({ device, onClose }: Props) {
  const termHostRef = useRef<HTMLDivElement>(null)
  const { user } = useAuth()
  const authToken = user?.token ?? ''

  useEffect(() => {
    const host = termHostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      theme: { background: '#0b0f19', foreground: '#e2e8f0', cursor: '#5eead4' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const { cols, rows } = term
    const url =
      `${proto}://${window.location.host}/ws/devices/${device.id}/shell` +
      `?token=${encodeURIComponent(authToken)}&cols=${cols}&rows=${rows}`

    const ws = new WebSocket(url)
    let disposed = false

    ws.onopen = () => term.focus()
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
    ws.onclose = () => { if (!disposed) term.write('\r\n\x1b[33m[bağlantı bağlandı]\x1b[0m\r\n') }

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }))
    })

    const sendResize = () => {
      try { fit.fit() } catch { /* not visible yet */ }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    }
    const ro = new ResizeObserver(() => sendResize())
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      dataSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [device.id, authToken])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 880, maxWidth: '96vw', height: 540, maxHeight: '90vh',
          background: '#0b0f19', borderRadius: 10, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', background: '#111827', borderBottom: '1px solid #1f2937',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>
            🖧 {device.vendor_name}
            <span style={{ color: '#64748b', fontFamily: 'monospace', marginLeft: 8 }}>
              ssh {device.ssh_username ?? 'root'}@{device.ip_address}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}
          >×</button>
        </div>
        <div ref={termHostRef} style={{ flex: 1, padding: 8, background: '#0b0f19' }} />
      </div>
    </div>
  )
}
