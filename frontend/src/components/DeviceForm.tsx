import { useState } from 'react'
import type { Device, DeviceCreate, DeviceType, DeviceUpdate } from '../types'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from '../lib/deviceIcons'

interface Props {
  device?: Device
  /** Pre-fill coordinates (e.g. from clicking the map when adding a device). */
  initialCoords?: { lat: number; lng: number }
  onSave: (data: DeviceCreate | DeviceUpdate) => Promise<void>
  onClose: () => void
}

const field: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 14,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  color: '#374151',
  marginBottom: 4,
}

const coordStr = (n: number | null | undefined, fallback?: number) =>
  n != null ? String(n) : fallback != null ? String(fallback) : ''

export function DeviceForm({ device, initialCoords, onSave, onClose }: Props) {
  const [form, setForm] = useState({
    vendor_name:   device?.vendor_name   ?? '',
    ip_address:    device?.ip_address    ?? '',
    model_name:    device?.model_name    ?? '',
    description:   device?.description   ?? '',
    location_text: device?.location_text ?? '',
    device_type:   (device?.device_type  ?? 'other') as DeviceType,
    latitude:      coordStr(device?.latitude,  initialCoords?.lat),
    longitude:     coordStr(device?.longitude, initialCoords?.lng),
    is_critical:   device?.is_critical   ?? false,
    is_enabled:    device?.is_enabled    ?? true,
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave({
        vendor_name:   form.vendor_name,
        ip_address:    form.ip_address,
        model_name:    form.model_name   || undefined,
        description:   form.description  || undefined,
        location_text: form.location_text || undefined,
        device_type:   form.device_type,
        latitude:      form.latitude  === '' ? null : Number(form.latitude),
        longitude:     form.longitude === '' ? null : Number(form.longitude),
        is_critical:   form.is_critical,
        is_enabled:    form.is_enabled,
      })
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Above Leaflet panes/controls (which reach ~400–1000) so the modal is
        // never hidden behind the map.
        zIndex: 4000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 12, padding: 28,
          width: 480, maxWidth: '95vw', boxShadow: '0 20px 48px rgba(0,0,0,0.22)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 600, color: '#1e293b' }}>
          {device ? 'Edit Device' : 'Add Device'}
        </h2>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <label style={label}>Vendor Name *</label>
              <input required style={field} value={form.vendor_name}
                onChange={(e) => set('vendor_name', e.target.value)} />
            </div>
            <div>
              <label style={label}>IP Address *</label>
              <input required style={{ ...field, fontFamily: 'monospace' }}
                value={form.ip_address} placeholder="192.168.1.1"
                onChange={(e) => set('ip_address', e.target.value)} />
            </div>
            <div>
              <label style={label}>Type (xəritə ikonu)</label>
              <select style={{ ...field, cursor: 'pointer' }} value={form.device_type}
                onChange={(e) => set('device_type', e.target.value)}>
                {DEVICE_TYPES.map(t => (
                  <option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={label}>Model</label>
                <input style={field} value={form.model_name}
                  onChange={(e) => set('model_name', e.target.value)} />
              </div>
              <div>
                <label style={label}>Location</label>
                <input style={field} value={form.location_text}
                  onChange={(e) => set('location_text', e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={label}>Latitude (en dairəsi)</label>
                <input style={{ ...field, fontFamily: 'monospace' }} type="number" step="any"
                  min={-90} max={90} placeholder="40.4093"
                  value={form.latitude}
                  onChange={(e) => set('latitude', e.target.value)} />
              </div>
              <div>
                <label style={label}>Longitude (uzunluq dairəsi)</label>
                <input style={{ ...field, fontFamily: 'monospace' }} type="number" step="any"
                  min={-180} max={180} placeholder="49.8671"
                  value={form.longitude}
                  onChange={(e) => set('longitude', e.target.value)} />
              </div>
            </div>
            <p style={{ margin: '-6px 0 0', fontSize: 11, color: '#94a3b8' }}>
              İpucu: koordinatları əl ilə yaza, və ya cihaz əlavə edərkən xəritəyə klikləyə bilərsiniz.
            </p>
            <div>
              <label style={label}>Description</label>
              <textarea style={{ ...field, height: 68, resize: 'vertical' }}
                value={form.description}
                onChange={(e) => set('description', e.target.value)} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" checked={form.is_enabled}
                onChange={(e) => set('is_enabled', e.target.checked)} />
              Enabled (include in ping loop)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: '#b91c1c', fontWeight: 600 }}>
              <input type="checkbox" checked={form.is_critical}
                onChange={(e) => set('is_critical', e.target.checked)} />
              ⚠ Kritik / vacib cihaz (təcili səsli xəbərdarlıq)
            </label>
          </div>

          {error && (
            <p style={{ color: '#dc2626', fontSize: 13, margin: '10px 0 0' }}>{error}</p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 14 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: '8px 20px', borderRadius: 6, border: 'none', background: '#1e40af', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
