import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, type AdminRole } from '../api/admin'
import { useAuth } from '../hooks/useAuth'

// Admin panel: user + role management. Access is PERMISSION-based — a role is
// just a named bundle of permissions; admins can compose custom roles here and
// assign them to users. Backend enforces everything (manage_users).

const PERMISSION_LABELS: Record<string, string> = {
  view: 'Status görmə (xəritə/cihaz statusu)',
  snmp: 'SNMP telemetriya və cihaz məlumatı',
  ssh: 'SSH / web-terminal bağlantısı',
  ack: 'Alarmı qəbul etmə (ack)',
  mute: 'Susdurma / texniki iş rejimi',
  edit_device: 'Cihaz əlavə/redaktə/silmə',
  edit_config: 'Monitorinq konfiqurasiyası (simulyasiya və s.)',
  manage_users: 'İstifadəçi və rol idarəetməsi',
}

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', padding: 18,
}
const inp: React.CSSProperties = {
  padding: '7px 11px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
}
const btnPrimary: React.CSSProperties = {
  background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6,
  padding: '7px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
}
const btnGhost: React.CSSProperties = {
  background: '#fff', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6,
  padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
}

function errDetail(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback
}

export function AdminPanel() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [tab, setTab] = useState<'users' | 'roles'>('users')

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{
        height: 56, background: '#0f172a', color: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: '#f1f5f9' }}>NetMonitor</div>
        <button onClick={() => navigate('/')}
          style={{ background: 'transparent', border: 'none', color: '#94a3b8', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
          ← Panelə qayıt
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#475569' }}>{user?.email}</span>
      </header>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 20px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20, color: '#0f172a' }}>⚙ İdarəetmə paneli</h1>
        <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
          Girişlər icazə əsaslıdır: rol = icazələr toplusu. İstifadəçiyə rol təyin edin,
          və ya lazımi icazə kombinasiyası ilə yeni rol yaradın.
        </p>

        <div style={{ display: 'flex', gap: 2, background: '#f1f5f9', borderRadius: 7, padding: 3, width: 'fit-content', marginBottom: 16 }}>
          {([['users', '👥 İstifadəçilər'], ['roles', '🛡 Rollar və icazələr']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{
                background: tab === k ? '#fff' : 'transparent', border: 'none', borderRadius: 5,
                padding: '6px 16px', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                fontWeight: tab === k ? 600 : 400, color: tab === k ? '#1e293b' : '#64748b',
                boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'users' ? <UsersTab selfEmail={user?.email ?? ''} /> : <RolesTab />}
      </div>
    </div>
  )
}

// ── Users tab ────────────────────────────────────────────────────────────────
function UsersTab({ selfEmail }: { selfEmail: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [nu, setNu] = useState({ email: '', password: '', role: 'viewer' })

  const { data: users = [] } = useQuery({ queryKey: ['admin-users'], queryFn: adminApi.users })
  const { data: roles = [] } = useQuery({ queryKey: ['admin-roles'], queryFn: adminApi.roles })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['admin-roles'] }) }

  const createM = useMutation({
    mutationFn: () => adminApi.createUser(nu.email, nu.password, nu.role),
    onSuccess: () => { setNu({ email: '', password: '', role: nu.role }); setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'İstifadəçi yaradıla bilmədi')),
  })
  const updateM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof adminApi.updateUser>[1] }) =>
      adminApi.updateUser(id, body),
    onSuccess: () => { setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Dəyişiklik alınmadı')),
  })
  const deleteM = useMutation({
    mutationFn: adminApi.deleteUser,
    onSuccess: () => { setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Silinmədi')),
  })

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* Add user */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 10 }}>Yeni istifadəçi</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, width: 220 }} placeholder="email@example.com" value={nu.email}
            onChange={e => setNu({ ...nu, email: e.target.value })} />
          <input style={{ ...inp, width: 160 }} type="password" placeholder="şifrə (min 6)" value={nu.password}
            onChange={e => setNu({ ...nu, password: e.target.value })} />
          <select style={{ ...inp, cursor: 'pointer' }} value={nu.role}
            onChange={e => setNu({ ...nu, role: e.target.value })}>
            {roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
          <button style={btnPrimary} disabled={createM.isPending || !nu.email || nu.password.length < 6}
            onClick={() => createM.mutate()}>
            {createM.isPending ? 'Yaradılır…' : '+ Yarat'}
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}

      {/* User table */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              {['Email', 'Rol', 'Status', 'Əməliyyatlar'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #e2e8f0' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const isSelf = u.email === selfEmail
              return (
                <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                  <td style={{ padding: '10px 14px', fontSize: 13, color: '#1e293b', fontWeight: 500, borderBottom: '1px solid #f1f5f9' }}>
                    {u.email}{isSelf && <span style={{ color: '#94a3b8', fontWeight: 400 }}> (siz)</span>}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9' }}>
                    <select value={u.role} disabled={isSelf}
                      onChange={e => updateM.mutate({ id: u.id, body: { role: e.target.value } })}
                      style={{ ...inp, padding: '4px 8px', fontSize: 12, cursor: isSelf ? 'not-allowed' : 'pointer' }}>
                      {roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600, color: u.is_active ? '#16a34a' : '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
                    {u.is_active ? '● aktiv' : '○ deaktiv'}
                  </td>
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 6 }}>
                    <button style={btnGhost} disabled={isSelf}
                      onClick={() => updateM.mutate({ id: u.id, body: { is_active: !u.is_active } })}>
                      {u.is_active ? 'Deaktiv et' : 'Aktiv et'}
                    </button>
                    <button style={btnGhost}
                      onClick={() => {
                        const p = window.prompt(`${u.email} üçün yeni şifrə (min 6 simvol):`)
                        if (p && p.length >= 6) updateM.mutate({ id: u.id, body: { password: p } })
                      }}>
                      Şifrə
                    </button>
                    <button style={{ ...btnGhost, color: '#ef4444', borderColor: '#fca5a5' }} disabled={isSelf}
                      onClick={() => { if (window.confirm(`${u.email} silinsin?`)) deleteM.mutate(u.id) }}>
                      Sil
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Roles tab ────────────────────────────────────────────────────────────────
function RolesTab() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [newRole, setNewRole] = useState<{ name: string; perms: Set<string> }>({ name: '', perms: new Set(['view']) })

  const { data: roles = [] } = useQuery({ queryKey: ['admin-roles'], queryFn: adminApi.roles })
  const { data: allPerms = [] } = useQuery({ queryKey: ['admin-permissions'], queryFn: adminApi.permissions })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-roles'] })

  const updateM = useMutation({
    mutationFn: ({ id, permissions }: { id: number; permissions: string[] }) =>
      adminApi.updateRole(id, permissions),
    onSuccess: () => { setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Rol yenilənmədi')),
  })
  const createM = useMutation({
    mutationFn: () => adminApi.createRole(newRole.name, Array.from(newRole.perms)),
    onSuccess: () => { setNewRole({ name: '', perms: new Set(['view']) }); setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Rol yaradıla bilmədi')),
  })
  const deleteM = useMutation({
    mutationFn: adminApi.deleteRole,
    onSuccess: () => { setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Rol silinmədi')),
  })

  const togglePerm = (role: AdminRole, perm: string) => {
    const next = role.permissions.includes(perm)
      ? role.permissions.filter(p => p !== perm)
      : [...role.permissions, perm]
    updateM.mutate({ id: role.id, permissions: next })
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}

      {roles.map(role => (
        <div key={role.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{role.name}</span>
            {role.builtin && (
              <span style={{ fontSize: 10, background: '#f1f5f9', color: '#64748b', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>daxili</span>
            )}
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{role.users} istifadəçi</span>
            {!role.builtin && role.users === 0 && (
              <button style={{ ...btnGhost, marginLeft: 'auto', color: '#ef4444', borderColor: '#fca5a5' }}
                onClick={() => { if (window.confirm(`"${role.name}" rolu silinsin?`)) deleteM.mutate(role.id) }}>
                Sil
              </button>
            )}
          </div>
          {role.name === 'manager' ? (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              Bütün icazələr — dəyişdirilə bilməz (bərpa/superadmin rolu).
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
              {allPerms.map(p => (
                <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#334155', cursor: 'pointer' }}>
                  <input type="checkbox" checked={role.permissions.includes(p)}
                    disabled={updateM.isPending}
                    onChange={() => togglePerm(role, p)} />
                  <code style={{ background: '#f1f5f9', borderRadius: 4, padding: '1px 5px', fontSize: 11 }}>{p}</code>
                  {PERMISSION_LABELS[p] ?? p}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Create role */}
      <div style={{ ...card, borderStyle: 'dashed' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 10 }}>Yeni rol yarat</div>
        <input style={{ ...inp, width: 240, marginBottom: 10 }} placeholder="rol adı (məs. noc-operator)"
          value={newRole.name} onChange={e => setNewRole({ ...newRole, name: e.target.value })} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6, marginBottom: 12 }}>
          {allPerms.map(p => (
            <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#334155', cursor: 'pointer' }}>
              <input type="checkbox" checked={newRole.perms.has(p)}
                onChange={() => {
                  const perms = new Set(newRole.perms)
                  if (perms.has(p)) perms.delete(p); else perms.add(p)
                  setNewRole({ ...newRole, perms })
                }} />
              <code style={{ background: '#f1f5f9', borderRadius: 4, padding: '1px 5px', fontSize: 11 }}>{p}</code>
              {PERMISSION_LABELS[p] ?? p}
            </label>
          ))}
        </div>
        <button style={btnPrimary} disabled={createM.isPending || newRole.name.length < 2 || newRole.perms.size === 0}
          onClick={() => createM.mutate()}>
          {createM.isPending ? 'Yaradılır…' : '+ Rol yarat'}
        </button>
      </div>
    </div>
  )
}
