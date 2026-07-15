import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '../hooks/useAuth'
import type { Device } from '../types'

interface Props {
  device: Device
  onClose: () => void
}

const WIDTH = 880
const HEIGHT = 540

/**
 * Browser SSH terminal: an xterm.js terminal bridged over a WebSocket to an
 * interactive SSH shell on the device (backend /ws/devices/{id}/shell).
 *
 * It's a FLOATING, DRAGGABLE window — no dimming backdrop — so:
 *   • an accidental click outside can never kill the session (only × closes it), and
 *   • the window can be parked aside by its title bar while you use the map behind it.
 *
 * The SSH password is typed here per-session and sent to the backend as the first
 * WebSocket frame ({type:'auth'}). It is used only for that one connection and is
 * never stored in the database.
 */
export function WebShell({ device, onClose }: Props) {
  const termHostRef = useRef<HTMLDivElement>(null)
  const { user } = useAuth()
  const authToken = user?.token ?? ''
  const sshUser = device.ssh_username ?? 'root'

  // Login gate: the terminal (and the WebSocket) only start once a password has
  // been submitted. The typed password is held in a ref so keystrokes don't
  // re-run the terminal effect.
  const [password, setPassword] = useState('')
  const [connected, setConnected] = useState(false)
  const pwRef = useRef('')
  const connect = useCallback(() => {
    pwRef.current = password
    setConnected(true)
  }, [password])

  // Floating-window top-left; starts centered, then the header drags it anywhere.
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, (window.innerWidth - WIDTH) / 2),
    y: Math.max(8, (window.innerHeight - HEIGHT) / 2),
  }))
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Never start a drag from the × button.
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    e.preventDefault()
  }, [pos.x, pos.y])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return
      const x = e.clientX - drag.current.dx
      const y = e.clientY - drag.current.dy
      // Keep the title bar reachable so the window can always be grabbed back.
      setPos({
        x: Math.min(Math.max(-WIDTH + 100, x), window.innerWidth - 100),
        y: Math.min(Math.max(0, y), window.innerHeight - 40),
      })
    }
    const onUp = () => { drag.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    if (!connected) return
    const host = termHostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      // Keep plenty of history so `show configuration` / long output can be
      // scrolled back through with the mouse wheel.
      scrollback: 5000,
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

    ws.onopen = () => {
      // First frame carries the per-session password (never persisted server-side).
      ws.send(JSON.stringify({ type: 'auth', password: pwRef.current }))
      term.focus()
    }
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
  }, [connected, device.id, authToken])

  return createPortal(
    <div
      style={{
        position: 'fixed', top: pos.y, left: pos.x,
        width: WIDTH, maxWidth: '96vw', height: HEIGHT, maxHeight: '90vh', zIndex: 5000,
        background: '#0b0f19', borderRadius: 10, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 60px rgba(0,0,0,0.5)', border: '1px solid #1f2937',
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', background: '#111827', borderBottom: '1px solid #1f2937',
          fontFamily: 'system-ui, sans-serif', cursor: 'move', userSelect: 'none',
        }}
      >
        <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>
          🖧 {device.vendor_name}
          <span style={{ color: '#64748b', fontFamily: 'monospace', marginLeft: 8 }}>
            ssh {sshUser}@{device.ip_address}
          </span>
        </div>
        <button
          onClick={onClose}
          title="Bağla"
          aria-label="Bağla"
          style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}
        >×</button>
      </div>

      {connected ? (
        <div ref={termHostRef} style={{ flex: 1, minHeight: 0, padding: '12px 8px', background: '#0b0f19' }} />
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); connect() }}
          style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 14, padding: 24,
            fontFamily: 'system-ui, sans-serif', color: '#e2e8f0',
          }}
        >
          <div style={{ fontSize: 14, color: '#94a3b8' }}>
            <span style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>{sshUser}@{device.ip_address}</span> üçün SSH parolu
          </div>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="SSH parolu"
            style={{
              width: 280, padding: '10px 12px', fontSize: 14, borderRadius: 6,
              border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0',
              fontFamily: 'inherit', outline: 'none',
            }}
          />
          <button
            type="submit"
            style={{
              padding: '9px 22px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: '#0d9488', color: '#fff', fontSize: 14, fontWeight: 600,
            }}
          >Qoşul</button>
          <div style={{ fontSize: 11, color: '#64748b', maxWidth: 320, textAlign: 'center' }}>
            Parol yalnız bu sessiya üçün istifadə olunur, verilənlər bazasında saxlanmır.
          </div>
        </form>
      )}
    </div>,
    document.body,
  )
}
