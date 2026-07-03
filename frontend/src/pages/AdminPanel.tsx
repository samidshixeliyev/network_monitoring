import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, type AdminRole, type AdminUser } from '../api/admin'
import { useAuth } from '../hooks/useAuth'

// Admin panel: user + role management. Access is PERMISSION-based — a role is
// just a named bundle of permissions; admins can compose custom roles here and
// assign them to users. Backend enforces everything (manage_users).
// All create/reset/delete flows use proper modal dialogs (no window.prompt).

const PERMISSION_LABELS: Record<string, string> = {
  view: 'Status görmə (xəritə/cihaz statusu)',
  snmp: 'SNMP telemetriya və cihaz məlumatı',
  ssh: 'SSH / web-terminal bağlantısı',
  mute: 'Susdurma / texniki iş rejimi',
  edit_device: 'Cihaz əlavə/redaktə/silmə',
  edit_config: 'Monitorinq konfiqurasiyası (simulyasiya və s.)',
  manage_users: 'İstifadəçi və rol idarəetməsi',
}

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', padding: 18,
}
const inp: React.CSSProperties = {
  padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
}
const label: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 4,
}
const btnPrimary: React.CSSProperties = {
  background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
}
const btnGhost: React.CSSProperties = {
  background: '#fff', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6,
  padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
}
const btnDanger: React.CSSProperties = {
  ...btnGhost, color: '#ef4444', borderColor: '#fca5a5',
}

function errDetail(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback
}

// ── Generic modal shell ──────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = 420 }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: number
}) {
  // Esc closes the dialog, like any native one.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 12, padding: 24, width, maxWidth: '94vw',
          boxShadow: '0 20px 48px rgba(0,0,0,0.25)', animation: 'nmModalIn 0.15s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{title}</h2>
          <button onClick={onClose} aria-label="Bağla"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 22, lineHeight: 1, padding: '0 2px' }}>
            ×
          </button>
        </div>
        {children}
        <style>{`@keyframes nmModalIn { from { transform: scale(0.97); opacity: 0 } to { transform: scale(1); opacity: 1 } }`}</style>
      </div>
    </div>
  )
}

// Password input with visibility toggle.
function PasswordField({ value, onChange, placeholder, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ ...inp, width: '100%', paddingRight: 38, fontFamily: show ? 'monospace' : 'inherit' }}
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
      />
      <button type="button" onClick={() => setShow(s => !s)} tabIndex={-1}
        title={show ? 'Gizlət' : 'Göstər'}
        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#64748b', padding: 4 }}>
        {show ? '🙈' : '👁'}
      </button>
    </div>
  )
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%'
  const arr = new Uint32Array(14)
  crypto.getRandomValues(arr)
  return Array.from(arr, n => chars[n % chars.length]).join('')
}

// ── Create-user modal ────────────────────────────────────────────────────────
function CreateUserModal({ roles, onClose, onDone }: {
  roles: AdminRole[]
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({ email: '', password: '', confirm: '', role: 'viewer' })
  const [error, setError] = useState<string | null>(null)

  const createM = useMutation({
    mutationFn: () => adminApi.createUser(form.email, form.password, form.role),
    onSuccess: () => { onDone(); onClose() },
    onError: (e) => setError(errDetail(e, 'İstifadəçi yaradıla bilmədi')),
  })

  const mismatch = form.confirm !== '' && form.password !== form.confirm
  const valid = /\S+@\S+\.\S+/.test(form.email) && form.password.length >= 6 && form.password === form.confirm

  return (
    <Modal title="Yeni istifadəçi" onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (valid) createM.mutate() }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <label style={label}>Email *</label>
            <input style={{ ...inp, width: '100%' }} type="email" autoFocus required
              placeholder="istifadeci@example.com" value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={label}>Şifrə * <span style={{ color: '#94a3b8', fontWeight: 400 }}>(min 6 simvol)</span></label>
              <button type="button" onClick={() => { const p = generatePassword(); setForm({ ...form, password: p, confirm: p }) }}
                style={{ background: 'none', border: 'none', color: '#1e40af', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', padding: 0 }}>
                ⚄ Təsadüfi yarat
              </button>
            </div>
            <PasswordField value={form.password} onChange={v => setForm({ ...form, password: v })} />
          </div>
          <div>
            <label style={label}>Şifrə (təkrar) *</label>
            <PasswordField value={form.confirm} onChange={v => setForm({ ...form, confirm: v })} />
            {mismatch && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>Şifrələr uyğun gəlmir</div>}
          </div>
          <div>
            <label style={label}>Rol</label>
            <select style={{ ...inp, width: '100%', cursor: 'pointer' }} value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}>
              {roles.map(r => (
                <option key={r.id} value={r.name}>
                  {r.name} — {r.permissions.join(', ') || 'icazəsiz'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onClose}
            style={{ ...btnGhost, padding: '8px 16px', fontSize: 13 }}>
            Ləğv et
          </button>
          <button type="submit" disabled={!valid || createM.isPending}
            style={{ ...btnPrimary, opacity: !valid || createM.isPending ? 0.6 : 1 }}>
            {createM.isPending ? 'Yaradılır…' : 'Yarat'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Password-reset modal ─────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose, onDone }: {
  user: AdminUser
  onClose: () => void
  onDone: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const resetM = useMutation({
    mutationFn: () => adminApi.updateUser(user.id, { password }),
    onSuccess: () => { onDone(); onClose() },
    onError: (e) => setError(errDetail(e, 'Şifrə dəyişdirilə bilmədi')),
  })

  const mismatch = confirm !== '' && password !== confirm
  const valid = password.length >= 6 && password === confirm

  return (
    <Modal title="Şifrəni sıfırla" onClose={onClose}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
        <b style={{ color: '#0f172a' }}>{user.email}</b> üçün yeni şifrə təyin edilir.
      </p>
      <form onSubmit={e => { e.preventDefault(); if (valid) resetM.mutate() }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={label}>Yeni şifrə * <span style={{ color: '#94a3b8', fontWeight: 400 }}>(min 6 simvol)</span></label>
              <button type="button" onClick={() => { const p = generatePassword(); setPassword(p); setConfirm(p) }}
                style={{ background: 'none', border: 'none', color: '#1e40af', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', padding: 0 }}>
                ⚄ Təsadüfi yarat
              </button>
            </div>
            <PasswordField value={password} onChange={setPassword} autoFocus />
          </div>
          <div>
            <label style={label}>Yeni şifrə (təkrar) *</label>
            <PasswordField value={confirm} onChange={setConfirm} />
            {mismatch && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>Şifrələr uyğun gəlmir</div>}
          </div>
        </div>

        {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ ...btnGhost, padding: '8px 16px', fontSize: 13 }}>
            Ləğv et
          </button>
          <button type="submit" disabled={!valid || resetM.isPending}
            style={{ ...btnPrimary, opacity: !valid || resetM.isPending ? 0.6 : 1 }}>
            {resetM.isPending ? 'Dəyişdirilir…' : 'Şifrəni dəyiş'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Confirm modal (delete flows) ─────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel, onConfirm, onClose, pending }: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
  pending?: boolean
}) {
  return (
    <Modal title={title} onClose={onClose} width={380}>
      <p style={{ margin: '0 0 18px', fontSize: 13.5, color: '#334155', lineHeight: 1.5 }}>{message}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={{ ...btnGhost, padding: '8px 16px', fontSize: 13 }}>Ləğv et</button>
        <button onClick={onConfirm} disabled={pending}
          style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}>
          {pending ? 'Gözləyin…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

// ── Page shell ───────────────────────────────────────────────────────────────
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
          {([['users', '👥 İstifadəçilər'], ['roles', '🛡 Rollar və icazələr']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{
                background: tab === k ? '#fff' : 'transparent', border: 'none', borderRadius: 5,
                padding: '6px 16px', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
                fontWeight: tab === k ? 600 : 400, color: tab === k ? '#1e293b' : '#64748b',
                boxShadow: tab === k ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}>
              {lbl}
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
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<AdminUser | null>(null)
  const [deleting, setDeleting] = useState<AdminUser | null>(null)

  const { data: users = [] } = useQuery({ queryKey: ['admin-users'], queryFn: adminApi.users })
  const { data: roles = [] } = useQuery({ queryKey: ['admin-roles'], queryFn: adminApi.roles })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['admin-roles'] }) }

  const updateM = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof adminApi.updateUser>[1] }) =>
      adminApi.updateUser(id, body),
    onSuccess: () => { setError(null); refresh() },
    onError: (e) => setError(errDetail(e, 'Dəyişiklik alınmadı')),
  })
  const deleteM = useMutation({
    mutationFn: adminApi.deleteUser,
    onSuccess: () => { setError(null); setDeleting(null); refresh() },
    onError: (e) => { setError(errDetail(e, 'Silinmədi')); setDeleting(null) },
  })

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {creating && (
        <CreateUserModal roles={roles} onClose={() => setCreating(false)} onDone={refresh} />
      )}
      {resetting && (
        <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={refresh} />
      )}
      {deleting && (
        <ConfirmModal
          title="İstifadəçini sil"
          message={<><b>{deleting.email}</b> hesabı birdəfəlik silinəcək. Davam edilsin?</>}
          confirmLabel="Sil"
          pending={deleteM.isPending}
          onConfirm={() => deleteM.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#64748b' }}>{users.length} istifadəçi</span>
        <button style={btnPrimary} onClick={() => setCreating(true)}>+ Yeni istifadəçi</button>
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}

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
                  <td style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button style={btnGhost} disabled={isSelf}
                        onClick={() => updateM.mutate({ id: u.id, body: { is_active: !u.is_active } })}>
                        {u.is_active ? 'Deaktiv et' : 'Aktiv et'}
                      </button>
                      <button style={btnGhost} onClick={() => setResetting(u)}>
                        🔑 Şifrə
                      </button>
                      <button style={btnDanger} disabled={isSelf} onClick={() => setDeleting(u)}>
                        Sil
                      </button>
                    </div>
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
  const [deletingRole, setDeletingRole] = useState<AdminRole | null>(null)

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
    onSuccess: () => { setError(null); setDeletingRole(null); refresh() },
    onError: (e) => { setError(errDetail(e, 'Rol silinmədi')); setDeletingRole(null) },
  })

  const togglePerm = (role: AdminRole, perm: string) => {
    const next = role.permissions.includes(perm)
      ? role.permissions.filter(p => p !== perm)
      : [...role.permissions, perm]
    updateM.mutate({ id: role.id, permissions: next })
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {deletingRole && (
        <ConfirmModal
          title="Rolu sil"
          message={<>"<b>{deletingRole.name}</b>" rolu silinəcək. Davam edilsin?</>}
          confirmLabel="Sil"
          pending={deleteM.isPending}
          onConfirm={() => deleteM.mutate(deletingRole.id)}
          onClose={() => setDeletingRole(null)}
        />
      )}

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
              <button style={{ ...btnDanger, marginLeft: 'auto' }} onClick={() => setDeletingRole(role)}>
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
