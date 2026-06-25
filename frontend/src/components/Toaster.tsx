export interface Toast {
  id: string
  kind: 'down' | 'up'
  critical?: boolean
  title: string
  detail: string
}

const STYLE = {
  down: { bg: '#fef2f2', border: '#fca5a5', bar: '#ef4444', text: '#991b1b' },
  up:   { bg: '#f0fdf4', border: '#86efac', bar: '#16a34a', text: '#166534' },
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const s = STYLE[toast.kind]
  const critical = toast.critical && toast.kind === 'down'

  return (
    <div
      style={{
        background: critical ? '#fee2e2' : s.bg,
        border: `${critical ? 2 : 1}px solid ${critical ? '#dc2626' : s.border}`,
        borderRadius: 10,
        boxShadow: critical ? '0 0 0 3px rgba(220,38,38,0.25), 0 8px 24px rgba(0,0,0,0.2)' : '0 8px 24px rgba(0,0,0,0.15)',
        overflow: 'hidden', minWidth: 290,
        animation: critical ? 'toastIn 0.2s ease-out, critPulse 1s ease-in-out infinite' : 'toastIn 0.2s ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {critical && (
            <div style={{ display: 'inline-block', background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', padding: '1px 7px', borderRadius: 4, marginBottom: 5 }}>
              ⚠ KRİTİK
            </div>
          )}
          <div style={{ fontWeight: 700, fontSize: 13, color: critical ? '#7f1d1d' : s.text }}>{toast.title}</div>
          <div style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace', marginTop: 2 }}>
            {toast.detail}
          </div>
          {critical && (
            <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4, fontWeight: 600 }}>
              Təcili müdaxilə tələb olunur — bağlamaq üçün ×
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Bağla"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1, padding: 0 }}
        >×</button>
      </div>
      {/* Non-critical toasts auto-close; show the 10s countdown bar. Critical
          toasts stay until acknowledged → no bar. */}
      {!critical && (
        <div style={{ height: 3, background: 'rgba(0,0,0,0.06)' }}>
          <div style={{ height: '100%', background: s.bar, width: '100%', animation: 'toastBar 10s linear forwards' }} />
        </div>
      )}
    </div>
  )
}

export function Toaster({ toasts, onClose }: { toasts: Toast[]; onClose: (id: string) => void }) {
  // Critical alerts float to the top for fastest reaction.
  const ordered = [...toasts].sort(
    (a, b) => Number(!!b.critical) - Number(!!a.critical),
  )
  return (
    <>
      <div
        style={{
          position: 'fixed', top: 68, right: 16, zIndex: 5000,
          display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360,
        }}
      >
        {ordered.map(t => <ToastCard key={t.id} toast={t} onClose={() => onClose(t.id)} />)}
      </div>
      <style>{`
        @keyframes toastIn { from { transform: translateX(110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes toastBar { from { width: 100%; } to { width: 0%; } }
        @keyframes critPulse { 0%,100% { box-shadow: 0 0 0 3px rgba(220,38,38,0.25), 0 8px 24px rgba(0,0,0,0.2); } 50% { box-shadow: 0 0 0 6px rgba(220,38,38,0.12), 0 8px 24px rgba(0,0,0,0.2); } }
      `}</style>
    </>
  )
}
