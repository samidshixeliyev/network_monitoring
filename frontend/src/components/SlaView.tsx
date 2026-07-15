import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSla, downloadSlaExport } from '../api/sla'

const RANGES = [
  { key: 'day', label: 'Gün' },
  { key: 'week', label: 'Həftə' },
  { key: 'month', label: 'Ay' },
] as const

function pctColor(p: number): string {
  return p >= 99.9 ? '#16a34a' : p >= 99 ? '#65a30d' : p >= 95 ? '#eab308' : '#ef4444'
}

export function SlaView() {
  const [range, setRange] = useState<string>('week')
  const [exporting, setExporting] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['sla', range], queryFn: () => fetchSla(range) })

  const onExport = async () => {
    setExporting(true)
    try {
      await downloadSlaExport(range)
    } catch {
      // eslint-disable-next-line no-alert
      alert('CSV export alınmadı')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#1e293b' }}>SLA / Uptime</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button key={r.key} onClick={() => setRange(r.key)}
              style={{
                padding: '4px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
                border: '1px solid ' + (range === r.key ? '#1e40af' : '#e2e8f0'),
                background: range === r.key ? '#1e40af' : '#fff',
                color: range === r.key ? '#fff' : '#475569', fontFamily: 'inherit',
              }}>
              {r.label}
            </button>
          ))}
        </div>
        <button onClick={onExport} disabled={exporting}
          style={{
            marginLeft: 'auto', fontSize: 13, color: '#1e40af', fontWeight: 600,
            background: 'none', border: 'none', cursor: exporting ? 'default' : 'pointer',
            fontFamily: 'inherit', opacity: exporting ? 0.6 : 1,
          }}>
          {exporting ? '⏳ export…' : '⬇ CSV export'}
        </button>
      </div>

      {isLoading || !data ? (
        <div style={{ color: '#94a3b8', fontSize: 14 }}>Yüklənir…</div>
      ) : (
        <>
          {/* Per-region summary cards */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
            {data.regions.map(r => (
              <div key={r.region} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 16px', minWidth: 140 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>{r.region}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: pctColor(r.uptime_pct) }}>{r.uptime_pct}%</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{r.devices} cihaz · {r.samples} nümunə</div>
              </div>
            ))}
          </div>

          {/* Per-device table */}
          <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['Cihaz', 'IP', 'Region', 'Uptime %', 'Nümunə'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #e2e8f0' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.devices.map(d => (
                  <tr key={d.device_id}>
                    <td style={{ padding: '10px 14px', fontSize: 14, color: '#1e293b', borderBottom: '1px solid #f1f5f9' }}>
                      {d.is_critical && <span style={{ color: '#dc2626' }}>⚠ </span>}{d.vendor_name}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, color: '#475569', borderBottom: '1px solid #f1f5f9' }}>{d.ip_address}</td>
                    <td style={{ padding: '10px 14px', fontSize: 13, color: '#64748b', borderBottom: '1px solid #f1f5f9' }}>{d.region ?? '—'}</td>
                    <td style={{ padding: '10px 14px', fontSize: 14, fontWeight: 700, color: pctColor(d.uptime_pct), borderBottom: '1px solid #f1f5f9' }}>{d.uptime_pct}%</td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>{d.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
