import { useState } from 'react'
import type { Device, DeviceCreate, DeviceType, DeviceUpdate } from '../types'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from '../lib/deviceIcons'
import { useBackdropClose } from '../lib/useBackdropClose'

interface Props {
  device?: Device
  /** Pre-fill coordinates (e.g. from clicking the map when adding a device). */
  initialCoords?: { lat: number; lng: number }
  /** All devices — used to populate the parent (dependency) dropdown. */
  allDevices?: Device[]
  onSave: (data: DeviceCreate | DeviceUpdate) => Promise<void>
  onClose: () => void
  /** Edit mode only: open a fresh "add device" form at THIS device's location,
   *  so another device can be added to the same rack/site. */
  onAddAnother?: () => void
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

export function DeviceForm({ device, initialCoords, allDevices = [], onSave, onClose, onAddAnother }: Props) {
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
    ssh_enabled:   device?.ssh_enabled   ?? false,
    ssh_username:  device?.ssh_username  ?? '',
    ssh_password:  '',
    ssh_port:      String(device?.ssh_port ?? 22),
    snmp_enabled:  device?.snmp_enabled ?? false,
    snmp_version:  (device?.snmp_version ?? '2c') as '2c' | '3',
    snmp_community: '',
    snmp_port:     String(device?.snmp_port ?? 161),
    // SNMPv3 (USM) — only used when snmp_version === '3'. Keys are write-only:
    // blank on edit keeps the stored key (like community / ssh_password).
    snmp_v3_user:       device?.snmp_v3_user ?? '',
    snmp_v3_auth_proto: (device?.snmp_v3_auth_proto ?? 'sha') as 'none' | 'md5' | 'sha' | 'sha256',
    snmp_v3_auth_key:   '',
    snmp_v3_priv_proto: (device?.snmp_v3_priv_proto ?? 'aes') as 'none' | 'des' | 'aes' | 'aes256',
    snmp_v3_priv_key:   '',
    parent_id:        device?.parent_id ?? '',
    check_tcp_port:   device?.check_tcp_port != null ? String(device.check_tcp_port) : '',
    check_http_url:   device?.check_http_url ?? '',
    check_http_expect: device?.check_http_expect != null ? String(device.check_http_expect) : '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // How many devices added so far in this "add multiple at one location" session.
  const [addedCount, setAddedCount] = useState(0)

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  // `keepOpen` powers "Save & add another": save this device, then reset only the
  // identity/credential fields while KEEPING latitude/longitude/location — so a
  // second (third…) device at the SAME map point can be added without the fiddly
  // job of clicking the exact same coordinate again.
  async function save(keepOpen: boolean) {
    if (!form.vendor_name.trim() || !form.ip_address.trim()) {
      setError('Vendor Name və IP Address tələb olunur')
      return
    }
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
        ssh_enabled:   form.ssh_enabled,
        ssh_port:      form.ssh_port === '' ? 22 : Number(form.ssh_port),
        ssh_username:  form.ssh_username || null,
        // Only send the password when the user typed one (keeps the stored
        // password on edit if left blank).
        ...(form.ssh_password ? { ssh_password: form.ssh_password } : {}),
        snmp_enabled:  form.snmp_enabled,
        snmp_version:  form.snmp_version,
        snmp_port:     form.snmp_port === '' ? 161 : Number(form.snmp_port),
        // Like ssh_password: only send when typed (blank keeps the stored one).
        ...(form.snmp_community ? { snmp_community: form.snmp_community } : {}),
        // SNMPv3 (USM) — harmless when version is 2c. Keys, like the community,
        // are only sent when typed so a blank field keeps the stored key on edit.
        snmp_v3_user:       form.snmp_v3_user || null,
        snmp_v3_auth_proto: form.snmp_v3_auth_proto,
        snmp_v3_priv_proto: form.snmp_v3_priv_proto,
        ...(form.snmp_v3_auth_key ? { snmp_v3_auth_key: form.snmp_v3_auth_key } : {}),
        ...(form.snmp_v3_priv_key ? { snmp_v3_priv_key: form.snmp_v3_priv_key } : {}),
        parent_id:        form.parent_id || null,
        check_tcp_port:   form.check_tcp_port === '' ? null : Number(form.check_tcp_port),
        check_http_url:   form.check_http_url || null,
        check_http_expect: form.check_http_expect === '' ? null : Number(form.check_http_expect),
      })
      if (keepOpen) {
        // Clear identity + credentials for the next device; keep coords/location
        // (and the shared toggles) so co-located rack devices are quick to add.
        setForm(f => ({
          ...f,
          vendor_name: '', ip_address: '', model_name: '', description: '',
          ssh_username: '', ssh_password: '', snmp_community: '',
          snmp_v3_user: '', snmp_v3_auth_key: '', snmp_v3_priv_key: '',
          parent_id: '', check_tcp_port: '', check_http_url: '', check_http_expect: '',
        }))
        setAddedCount(c => c + 1)
      } else {
        onClose()
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void save(false)
  }

  const backdrop = useBackdropClose(onClose)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Above Leaflet panes/controls (which reach ~400–1000) so the modal is
        // never hidden behind the map.
        zIndex: 4000,
      }}
      {...backdrop}
    >
      <div
        style={{
          background: '#fff', borderRadius: 12, padding: 28,
          width: 480, maxWidth: '95vw', boxShadow: '0 20px 48px rgba(0,0,0,0.22)',
          // The form (esp. with SSH + SNMPv3 sections expanded) can be taller than
          // the viewport — cap the height and scroll inside so the footer buttons
          // stay reachable on short screens.
          maxHeight: '92vh', overflowY: 'auto',
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

            {/* ── SSH telemetry ──────────────────────────────────────────── */}
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#0f766e' }}>
                <input type="checkbox" checked={form.ssh_enabled}
                  onChange={(e) => set('ssh_enabled', e.target.checked)} />
                SSH ilə məlumat topla (hostname / uptime / interfeyslər)
              </label>
              {form.ssh_enabled && (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr', gap: 12, marginTop: 10 }}>
                  <div>
                    <label style={label}>SSH user</label>
                    <input style={field} value={form.ssh_username} placeholder="root"
                      onChange={(e) => set('ssh_username', e.target.value)} />
                  </div>
                  <div>
                    <label style={label}>SSH password</label>
                    <input style={field} type="password"
                      value={form.ssh_password}
                      placeholder={device?.ssh_username ? '•••••• (dəyişmə)' : ''}
                      onChange={(e) => set('ssh_password', e.target.value)} />
                  </div>
                  <div>
                    <label style={label}>Port</label>
                    <input style={{ ...field, fontFamily: 'monospace' }} type="number" min={1} max={65535}
                      value={form.ssh_port}
                      onChange={(e) => set('ssh_port', e.target.value)} />
                  </div>
                </div>
              )}
            </div>

            {/* ── SNMP telemetry ─────────────────────────────────────────── */}
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#1e40af' }}>
                <input type="checkbox" checked={form.snmp_enabled}
                  onChange={(e) => set('snmp_enabled', e.target.checked)} />
                SNMP ilə məlumat topla (CPU / RAM / interfeys trafiki)
              </label>
              {form.snmp_enabled && (
                <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                  {/* Per-device version: v2c (community) OR v3 (USM user + keys). */}
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                    <div>
                      <label style={label}>Versiya</label>
                      <select style={{ ...field, cursor: 'pointer' }} value={form.snmp_version}
                        onChange={(e) => set('snmp_version', e.target.value)}>
                        <option value="2c">v2c (community)</option>
                        <option value="3">v3 (user + açarlar)</option>
                      </select>
                    </div>
                    <div>
                      <label style={label}>Port</label>
                      <input style={{ ...field, fontFamily: 'monospace' }} type="number" min={1} max={65535}
                        value={form.snmp_port}
                        onChange={(e) => set('snmp_port', e.target.value)} />
                    </div>
                  </div>

                  {form.snmp_version === '2c' ? (
                    <div>
                      <label style={label}>Community (v2c)</label>
                      <input style={field} type="password"
                        value={form.snmp_community}
                        placeholder={device?.snmp_enabled ? '•••••• (dəyişmə)' : 'public'}
                        onChange={(e) => set('snmp_community', e.target.value)} />
                    </div>
                  ) : (
                    <>
                      <div>
                        <label style={label}>İstifadəçi (v3 user)</label>
                        <input style={field} value={form.snmp_v3_user} placeholder="snmpuser"
                          onChange={(e) => set('snmp_v3_user', e.target.value)} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
                        <div>
                          <label style={label}>Auth proto</label>
                          <select style={{ ...field, cursor: 'pointer' }} value={form.snmp_v3_auth_proto}
                            onChange={(e) => set('snmp_v3_auth_proto', e.target.value)}>
                            <option value="none">none</option>
                            <option value="md5">MD5</option>
                            <option value="sha">SHA</option>
                            <option value="sha256">SHA-256</option>
                          </select>
                        </div>
                        <div>
                          <label style={label}>Auth açarı</label>
                          <input style={field} type="password"
                            value={form.snmp_v3_auth_key}
                            placeholder={device?.snmp_v3_user ? '•••••• (dəyişmə)' : ''}
                            disabled={form.snmp_v3_auth_proto === 'none'}
                            onChange={(e) => set('snmp_v3_auth_key', e.target.value)} />
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
                        <div>
                          <label style={label}>Priv proto</label>
                          <select style={{ ...field, cursor: 'pointer' }} value={form.snmp_v3_priv_proto}
                            onChange={(e) => set('snmp_v3_priv_proto', e.target.value)}>
                            <option value="none">none</option>
                            <option value="des">DES</option>
                            <option value="aes">AES</option>
                            <option value="aes256">AES-256</option>
                          </select>
                        </div>
                        <div>
                          <label style={label}>Priv açarı</label>
                          <input style={field} type="password"
                            value={form.snmp_v3_priv_key}
                            placeholder={device?.snmp_v3_user ? '•••••• (dəyişmə)' : ''}
                            disabled={form.snmp_v3_priv_proto === 'none'}
                            onChange={(e) => set('snmp_v3_priv_key', e.target.value)} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── Dependency + multi-condition checks ─────────────────────── */}
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
                Asılılıq və əlavə yoxlamalar
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={label}>Parent cihaz (down olanda alarm susdurulur)</label>
                <select style={{ ...field, cursor: 'pointer' }} value={form.parent_id}
                  onChange={(e) => set('parent_id', e.target.value)}>
                  <option value="">— yoxdur —</option>
                  {allDevices.filter(d => d.id !== device?.id).map(d => (
                    <option key={d.id} value={d.id}>{d.vendor_name} ({d.ip_address})</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 12 }}>
                <div>
                  <label style={label}>TCP port</label>
                  <input style={{ ...field, fontFamily: 'monospace' }} type="number" min={1} max={65535}
                    placeholder="443" value={form.check_tcp_port}
                    onChange={(e) => set('check_tcp_port', e.target.value)} />
                </div>
                <div>
                  <label style={label}>HTTP URL</label>
                  <input style={field} placeholder="http://host/health" value={form.check_http_url}
                    onChange={(e) => set('check_http_url', e.target.value)} />
                </div>
                <div>
                  <label style={label}>Gözlənilən</label>
                  <input style={{ ...field, fontFamily: 'monospace' }} type="number" min={100} max={599}
                    placeholder="200" value={form.check_http_expect}
                    onChange={(e) => set('check_http_expect', e.target.value)} />
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p style={{ color: '#dc2626', fontSize: 13, margin: '10px 0 0' }}>{error}</p>
          )}
          {/* "Add multiple at one location" progress hint (create mode only). */}
          {!device && addedCount > 0 && (
            <p style={{ color: '#0f766e', fontSize: 12.5, margin: '10px 0 0', fontWeight: 600 }}>
              ✓ {addedCount} cihaz bu nöqtəyə əlavə olundu — növbətini daxil edin, ya da “Bitir”.
            </p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 14 }}>
              {addedCount > 0 ? 'Bitir' : 'Cancel'}
            </button>
            {/* Edit mode: jump to adding a NEW device at this same location. */}
            {device && onAddAnother && (
              <button type="button" onClick={onAddAnother}
                title="Bu cihazın yerinə (eyni nöqtəyə) yeni cihaz əlavə et"
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #0d9488', background: '#fff', color: '#0d9488', cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>
                + Bu nöqtəyə yeni cihaz
              </button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {/* Only offered when creating: keep the modal open at the same coords. */}
              {!device && (
                <button type="button" disabled={saving} onClick={() => void save(true)}
                  title="Bu cihazı saxla və eyni nöqtəyə daha bir əlavə et"
                  style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #0d9488', background: '#fff', color: '#0d9488', cursor: 'pointer', fontSize: 14, fontWeight: 600, opacity: saving ? 0.7 : 1 }}>
                  + Saxla və daha bir
                </button>
              )}
              <button type="submit" disabled={saving}
                style={{ padding: '8px 20px', borderRadius: 6, border: 'none', background: '#1e40af', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : device ? 'Save' : addedCount > 0 ? 'Saxla və bitir' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
