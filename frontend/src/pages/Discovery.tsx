import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { discoveryApi } from '../api/discovery'
import { useAuth } from '../hooks/useAuth'
import type { DiscoveredDevice } from '../types'

/** Pending inventory from the ICMP discovery sweep: approve (→ monitored
 *  device) or ignore each responding-but-unmonitored IP. */
export function Discovery() {
  const { user, logout, hasPermission } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [showIgnored, setShowIgnored] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)

  const { data: status } = useQuery({ queryKey: ['discovery-status'], queryFn: discoveryApi.status })
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['discovery', showIgnored],
    queryFn: () => discoveryApi.list(showIgnored),
    refetchInterval: 30_000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['discovery'] })
    qc.invalidateQueries({ queryKey: ['discovery-status'] })
  }

  const approve = useMutation({
    mutationFn: (row: DiscoveredDevice) => discoveryApi.approve(row.id),
    onSuccess: (device) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['devices'] })
      setBanner(`✓ ${device.vendor_name} (${device.ip_address}) monitorinqə əlavə olundu`)
    },
    onError: () => setBanner('✗ Əlavə etmək alınmadı (IP artıq mövcud ola bilər)'),
  })
  const ignore = useMutation({
    mutationFn: (row: DiscoveredDevice) => discoveryApi.ignore(row.id),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (row: DiscoveredDevice) => discoveryApi.remove(row.id),
    onSuccess: invalidate,
  })
  const sweep = useMutation({
    mutationFn: () => discoveryApi.sweep(),
    onSuccess: (r) => {
      invalidate()
      setBanner(`Skan bitdi: ${r.swept} yoxlanıldı, ${r.alive} cavab verdi, ${r.new} yeni`)
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setBanner(`✗ ${msg ?? 'Skan alınmadı'}`)
    },
  })

  const navItems: [string, string][] = [['Devices', '/'], ['Events', '/events']]
  if (hasPermission('edit_device')) navItems.push(['Discovery', '/discovery'])

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{
        height: 56, background: '#0f172a', color: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: '#f1f5f9', flexShrink: 0 }}>NetMonitor</div>
        <nav style={{ display: 'flex', gap: 2 }}>
          {navItems.map(([label, path]) => (
            <button key={label} onClick={() => navigate(path)}
              style={{
                background: path === '/discovery' ? 'rgba(255,255,255,0.12)' : 'transparent',
                border: 'none', color: path === '/discovery' ? '#fff' : '#94a3b8',
                borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13,
                fontFamily: 'inherit', fontWeight: 500,
              }}>
              {label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: '#475569' }}>{user?.email}</span>
          <span style={{ fontSize: 11, background: '#1e3a5f', color: '#93c5fd', borderRadius: 4, padding: '2px 7px', fontWeight: 600 }}>{user?.role}</span>
          <button onClick={() => { logout(); navigate('/login') }}
            style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8', borderRadius: 6, padding: '4px 11px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
            Logout
          </button>
        </div>
      </header>

      <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1e293b' }}>Auto-Discovery</h2>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#64748b' }}>
              {status?.enabled
                ? <>Aktiv — subnetlər: <code>{status.subnets || '—'}</code>, hər {Math.round((status.interval_seconds ?? 0) / 60)} dəq</>
                : 'Dövri skan söndürülüb (DISCOVERY_ENABLED=false) — əl ilə skan işlədilə bilər'}
              {status && <> · gözləyən: <b>{status.pending}</b></>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} />
              ignore olunanları göstər
            </label>
            <button onClick={() => sweep.mutate()} disabled={sweep.isPending}
              style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: '#1e40af', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: sweep.isPending ? 0.6 : 1 }}>
              {sweep.isPending ? 'Skan gedir…' : '⟳ İndi skan et'}
            </button>
          </div>
        </div>

        {banner && (
          <div style={{ margin: '10px 0', padding: '9px 14px', borderRadius: 8, fontSize: 13, background: banner.startsWith('✗') ? '#fef2f2' : '#f0fdf4', color: banner.startsWith('✗') ? '#b91c1c' : '#166534', border: '1px solid ' + (banner.startsWith('✗') ? '#fecaca' : '#bbf7d0') }}>
            {banner}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
              Gözləyən cihaz yoxdur. <code>DISCOVERY_SUBNETS</code> qurun və skan işlədin —
              cavab verən, amma monitorinqdə olmayan IP-lər burada görünəcək.
            </div>
          ) : rows.map(row => (
            <div key={row.id}
              style={{
                background: '#fff', borderRadius: 9, border: '1px solid #e2e8f0',
                padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14,
                opacity: row.status === 'ignored' ? 0.55 : 1,
              }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{row.ip_address}</span>
                  {row.hostname && <span style={{ fontSize: 12, color: '#64748b' }}>{row.hostname}</span>}
                  {row.rtt_ms != null && (
                    <span style={{ fontSize: 11, color: '#0f766e', background: '#f0fdfa', borderRadius: 4, padding: '1px 6px' }}>{row.rtt_ms.toFixed(1)} ms</span>
                  )}
                  {row.status === 'ignored' && (
                    <span style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>ignored</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                  ilk: {new Date(row.first_seen).toLocaleString()} · son: {new Date(row.last_seen).toLocaleString()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => approve.mutate(row)} disabled={approve.isPending}
                  style={{ padding: '6px 14px', borderRadius: 7, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit' }}>
                  ✓ Monitorinqə al
                </button>
                {row.status !== 'ignored' && (
                  <button onClick={() => ignore.mutate(row)}
                    style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                    Ignore
                  </button>
                )}
                <button onClick={() => remove.mutate(row)} title="Siyahıdan sil (növbəti skanda yenidən görünə bilər)"
                  style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
